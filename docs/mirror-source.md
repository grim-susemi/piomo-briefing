# 질문 알림 미러: 사용한 경로와 근거

선택: **공개 이벤트 버스** `pi.events.on('ask-user:asked' | 'ask-user:closed')`. 내부 모듈은 import하지 않는다.

## 근거 줄

- DOCS `extensions.md` 'Pending-question bus events'(작성 시 770-789행): `ask-user:asked` = `{ ctx, request, variant }`, `ask-user:closed` = `{ requestId, status, resolvedBy? }`, "Exactly one terminal outcome per question, including cancellation, timeout, orphaned restart recovery and unavailable UI". `resolvedBy`는 답 없이 끝난 질문에서는 없다. 요청은 겹칠 수 있으므로 ID 집합으로 추적한다.
- `SENPI/extensions/builtin/ask-user/notify.js:1-3, 12-18`: 채널 이름 상수와 `emitAskUserClosed(pi, requestId, response)` -> `{ requestId, status, resolvedBy? }`.
- `SENPI/extensions/builtin/ask-user/tool.js:162`: `pi.events.emit(ASK_USER_ASKED_EVENT, { ctx, request, variant })`는 질문 UI가 실제로 등록된 뒤에만 나간다(UI가 없으면 `asked` 없이 `closed(status:'unavailable')`만 나감 - 미러는 모르는 ID의 closed를 무시한다). 268행: 기본 30분 유휴 시간 초과.
- `SENPI/extensions/types.d.ts` `QuestionRequest`(86행: `requestId`, `questions[{id, header, question, options[{label, description?}], multiSelect}]`, `waitForAnswer`, `timeoutMs`, `required?`)와 `QuestionResponse.status`(`answered | comment-submitted | timed_out | cancelled | orphaned-after-restart | unavailable`).
- `SENPI/event-bus.js`: `on()`은 해제 함수를 돌려주고 핸들러 예외는 버스가 삼킨다(그래서 핸들러는 동기로 끝나고 예외를 밖으로 내지 않는다).
- 테스트 fixture `test/fixtures/mirror/ask-user-events.json`이 위 payload 형태를 옮긴 것이고, `test/mirror.test.mjs`의 마지막 테스트가 설치된 `notify.js`의 채널 이름이 그대로인지 확인한다(설치본이 없으면 건너뜀).

## 동작

| 이벤트 | 동작 |
| --- | --- |
| `asked` | `mirror/<sid>.json` = `{open:true, question, paneId, at, pid, requests[]}` 교체 쓰기 + 상황판 갱신. 읽기 전용(답하는 길 없음). 다른 세션 ctx의 질문, 형태가 틀린 payload는 무시 |
| `closed`, 답함(`answered`/`comment-submitted` 또는 `resolvedBy` 있음) | mirror 항목 제거(마지막 항목이면 파일 삭제), 결정 0건 |
| `closed`, 답 없음(`timed_out`, `cancelled`, `orphaned-after-restart` 등) | mirror 제거 + 질문마다(선택지 2개 이상일 때) `decisions/<id>.json`, `source:'question-timeout'`. 앞 3개 선택지 = A/B/C, **잘라내기 전 전체 라벨**에 `추천`/`Recommended`(대소문자 무시)가 있는 첫 항목 = recommend(괄호/대괄호로 둘러싼 표지는 카드 선택지 문구에서 뺀다), 없으면 A. `reason` = '질문 알림 시간 초과로 옮김'(시간 초과 외에는 '질문 알림이 답 없이 닫혀 옮김'). `blocks` = 요청의 `required === true`. 자동 답 없음 |
| 알 수 없는 ID의 `closed`, 이미 닫힌 ID | 무시 |
| 이벤트 버스를 쓸 수 없음(`pi.events` 없음, `on` 없음, `on()`이 던짐) | `meta.mirrorUnavailable = true` 만 기록 -> '질문 미러 사용 불가' 칩. 나머지 기능은 그대로 |

추가 필드: 결정 기록에 `requestId`, `questionIndex`를 더 적는다(같은 질문이 두 번 카드가 되는 것을 막는 멱등 키; 읽는 쪽은 모르는 필드를 무시한다).

## 알려진 한계

- 선택지가 2개 미만인 질문(자유 입력)은 카드로 만들 수 없어 열린 동안 표시만 하고 닫히면 사라진다.
- 프로세스가 죽어 `closed`를 못 받은 질문의 mirror 파일은 같은 세션이 다시 열릴 때(살아 있는 pid가 아니면) 지운다. 호스트는 재시작 때 같은 `requestId`로 `asked`를 다시 내고 `orphaned-after-restart`로 닫으므로 그때 카드가 된다.
- `blocks:true` 알림은 확장의 기존 알림 함수(Herdr CLI 우선, 쓸 수 없으면 `ctx.ui.notify`)를 `createMirror`의 `notify` 옵션으로 받아 쓴다. 옵션이 없으면 `ctx.ui.notify`만 쓴다.
