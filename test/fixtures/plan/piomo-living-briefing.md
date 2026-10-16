# piomo-living-briefing - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**Who this is for and what changes for them:** 여러 AI 대화를 동시에 돌리지만 코드를 읽을 시간이 없는 소유자다. 긴 채팅 보고 대신 상황판 한 장을 훑어보고, 어느 창에서든 '12번은 A' 같은 한 줄로 답하면 해당 대화가 이어서 일한다.

**What you'll get:** piomo에 붙는 확장 하나다. 대화별 카드(나를 기다림/진행 중/끝남), 번호가 붙은 결정 카드와 추천안, '증거 있음/보고만 됨'·'후보/실사용' 표시, 자동 갱신되는 브라우저 상황판, 짧아진 채팅 답, 한 줄 답을 해당 대화에 전달하는 기능, 짧은 한글 안내서가 들어 있다.

**Why this approach:** AI는 정해진 칸만 채우고 화면은 프로그램이 그리기 때문에, 길이와 형식을 기계가 지킨다. 또 원본 하네스를 고치지 않는 확장이라, 파일 하나만 지우면 원래 상태로 돌아간다. 터미널 대시보드는 이미 공간이 부족해 잘리므로 브라우저 페이지를 골랐다.

**What it will NOT do:** 새 터미널 창을 만들거나 다른 창에 키를 치지 않는다. 항상 도는 서버·예약 작업·유료 서비스·외부 라이브러리를 쓰지 않는다. 결정 기록을 설치·푸시·삭제 승인으로 취급하지 않고, 커밋·푸시는 따로 물어본 뒤에만 한다.

**Effort:** Large
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** Medium - Windows에서 쉬고 있는 대화를 답으로 깨울 수 있는지와 AI가 보고 칸을 꼬박꼬박 채우는지는 실행 중 시험으로 확인해야 한다. 안 되면 '다음에 그 대화가 움직일 때 전달'과 '마지막 답 자동 요약'으로 대신한다.
**Decisions to sanity-check:** (1) 상황판은 브라우저 페이지다(터미널 아님). (2) 답은 어느 창에서든 할 수 있다(네 선택). (3) 마지막에 실사용 piomo에 설치하되, 이미 열려 있던 대화에는 새로 열어야 적용된다. (4) 커밋은 끝난 뒤 한 번 물어본다. (5) 시험에서 실제 AI에 보내는 질문은 최대 4번이다(답이 길면 줄여 다시 쓰게 하는 호출이 질문당 최대 1번 더 붙을 수 있음). (6) 채팅 답이 길면 확장이 한 번 줄여 다시 쓰게 하고, 그래도 길면 코드로 잘라 맞춘다(나머지는 상황판에서 본다). 그래서 긴 답 아래에 짧은 답이 하나 더 보일 수 있다.

Your next move: 고정밀 검토가 통과하면 `/ulw-execute piomo-living-briefing`로 실행을 시작한다(이 대화나 새 대화). Full execution detail follows below.

---

> TL;DR (machine): Large; Medium risk; removable pi extension omo-briefing (brief tool, file:// dashboard, /decide cross-session delivery via admitExternalMessage, question mirror, installer) - 16 todos in 4 waves + F1-F4; no commits/push; live install at end.

## Scope
### Affected user and ideal state
<!-- From the draft ledger: who this touches and how they use the result, then one IS row per property with its reason, then one GAP row per difference with its reason. Every todo below closes a GAP row; ## Success criteria proves every IS row. -->
**Affected user:**
- 소유자(코드를 잘 읽지 않음): Orca -> Herdr -> OMO 대화 여러 개를 동시에 돌린다(`herdr agent list` 6개, 한 폴더 `.omo/boulder.json` works 44개). 지금은 대화마다 긴 채팅 보고를 읽어야 판단할 수 있어 사람이 병목이다. 이후에는 브라우저의 상황판 한 장을 훑어 상태·변화·결정만 보고, 아무 대화창에서나 `/decide 12A` 한 줄로 답한다.
- 리드 OMO 에이전트: 지금은 턴 끝에 긴 산문 보고를 쓴다. 이후에는 길이가 제한된 `brief` 도구 입력을 채우고 채팅 답은 짧게 끝낸다. 작업자(자식 세션)는 영향 없음(도구 미등록).
- 기존 하네스 확장(omo-herdr-dashboard 등)과 다른 OMO 프로세스: 이 확장이 그들의 파일·창·기록을 건드리거나 느리게 하면 안 된다.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | 상황판 첫 화면에서 대화별 '어디까지 왔나 / 뭐가 바뀌었나 / 내가 뭘 정해야 하나'가 코드 없이 보인다(요약 6줄·변화 3행·결정 카드 2장 이내, 나머지는 개수 표시 후 접힘) | 사람이 병목, 긴 글을 못 읽음 |
| IS-2 | 결정은 고정 번호 카드(질문·A/B(/C)·결과·추천+이유)로 보이고, 아무 대화창에서 `/decide 12A 13B`(번호만 쓰면 추천안) 한 줄로 답하면 그 결정을 만든 대화가 받아 진행하고 상황판에 전달 영수증이 뜨며, 틀린 번호·이미 답한 번호가 섞이면(두 창에서 같은 순간 답한 경우 포함) 아무것도 적용되지 않는다 | 빠른 결정·창 이동 제거(소유자 선택 Q1=A) |
| IS-3 | 모든 완료·변화 항목에 '증거 있음 / 보고만 됨 / 미확인'과 '후보 / 실사용 적용 / 적용 해당 없음' 표시가 하나씩 반드시 붙고, 증거 파일이 없거나 바뀌면 자동으로 낮춰 표시된다 | '완료' 오독으로 판단이 틀어진 이력 |
| IS-4 | 도구를 쓴 작업 턴에서 채팅 맨 끝에 남는 답은 빈 줄 제외 10줄·700자 이내이고 상황판 절대경로를 포함한다. 넘으면 확장이 같은 실행에서 한 번 줄여 다시 쓰게 하고, 그래도 넘으면 확장이 코드로 잘라 기준에 맞춘다. 상세는 상황판에 있다 | 긴 글이 핵심 불편 |
| IS-5 | 한 페이지 안에서 왼쪽 목차의 '나를 기다림 / 진행 중 / 끝남' 탭 전환, 스크롤 스파이 강조, 상단 가로 버튼 줄 없음, 빽빽한 카드(줄바꿈 앞 기호, `[작업명]` 대괄호 태그, 시각 앞 ⏱), 쉬운 한국어, 절대경로+복사 버튼, 단계 흐름 그림 | 소유자 문서·대시보드 UI 선호 기록 |
| IS-6 | 작업 턴이 끝나면 상황판이 자동 갱신되고(추가 AI 호출 없음), 카드마다 ⏱ 마지막 갱신·'보고 없음'·'오래됨' 표시가 있으며, 열어둔 페이지는 읽는 중 스크롤·탭이 튀지 않고 '새 내용 있음' 배지를 눌러야 반영된다 | 살아있는 문서 + 읽기 안정성 |
| IS-7 | 여러 대화 중 '나를 기다리는 대화'(열린 결정·막힘·열린 질문 알림)가 한 장에 모이고, 작업명·todo 현재/다음·작업자 수는 자동 수집된다 | 여러 세션 동시 운용 |
| IS-8 | 설치된 원본 번들·다른 확장은 바이트 무변경, 관리 shim 1개 삭제(또는 `--uninstall`)로 끄고 `/brief off`로 일시 중지, 상주 데몬·예약 작업·유료 서비스·외부 라이브러리 없음, senpi-task 기록 폴더를 감시·잦은 읽기 하지 않음 | 소유자 하네스 규칙 + EPERM 이력 |
| GAP-1 | 상황판 화면이 없다(채팅 글뿐) | IS-1, IS-5 |
| GAP-2 | 결정 요청이 본문에 섞이고 번호·추천 형식·다른 창에서 답하는 길이 없다 | IS-2 |
| GAP-3 | 확인/보고/적용 구분을 기계가 강제하지 않는다 | IS-3 |
| GAP-4 | 채팅 보고 길이 규칙이 없다 | IS-4 |
| GAP-5 | 갱신 시점·신선도·읽기 안정성 장치가 없다 | IS-6 |
| GAP-6 | 대화들을 가로질러 대기 상태를 모아 보는 곳이 없다(대시보드는 작업자·todo 위주, 공간 부족으로 잘림) | IS-7 |
| GAP-7 | 이 기능을 담은 확장·설치·끄기 경로가 없다 | IS-8 |

**고정 경로(모든 todo가 이 약어를 씁니다)**
- `REPO` = `C:/Users/USER/orca/projects/piomo-briefing` (새로 만드는 소스 저장소, 현재 없음)
- `AGENT` = `C:/Users/USER/.omo-stable-500/home/.omo/agent` (실사용 프로필)
- `DOCS` = `AGENT/runtime/<최신 buildId>/docs` (작성 시점 `0b0c6ca88f3a3632-4d63ae59570c`; 실행 시 `ls -t AGENT/runtime | head -1`로 다시 고르고, 줄 번호 대신 제목 문자열로 찾는다)
- `SENPI` = `C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/core`
- `PROJ` = `C:/Users/USER/orca/projects/기타 작업`
- `STATE` = 확장 상태 폴더. 기본값은 설치된 확장 위치 기준 `AGENT/briefing/state`(import.meta.url에서 `../../state`), 환경변수 `OMO_BRIEFING_STATE_DIR`가 있으면 그 값.
- `EV` = 증거 폴더(아래 Verification strategy).

### Must have

**저장소 배치(STATE 아래, 확장만 씁니다)**
```
settings.json                         {enabled:true}   (교체 쓰기)
sessions/<sid>/meta.json              {sessionId,cwd,project,title,paneId,workId,workerIds[],lastActivityAt,lastBriefAt,lastOwnerInputAt,turnDidWork,turnBriefed}  (교체 쓰기)
sessions/<sid>/briefs/<seq 6자리>.json   brief 입력+판정 결과  (새 파일, wx)
decisions/<id 6자리>.json           {id,sessionId,question,options,recommend,reason,blocks,createdAt,source:'brief'|'question-timeout'}  (새 파일, wx)
decision-closures/<id>.json           {id,reason:'superseded'|'withdrawn',at}  (새 파일, wx)
answers/<id>.json                     {id,option,at,fromSessionId}  (새 파일, wx)
claims/<id>.json                      {id,pid,at,nonce}  /decide 번호 선점  (새 파일, wx; 답이 쓰이면 영구, 답 없이 pid가 죽었으면 아래 '오래된 잠금·선점 회수' 규칙으로 회수; 회수 묘비 `<파일>.stale-<nonce>`는 지우지 않음)
receipts/<id>.json                    {id,sessionId,deliveredAt,kind:'started'|'queued'|'steered'|'already_admitted'|'fallback',mode:'immediate'|'after-turn'|'on-resume',proven:boolean}  (새 파일, wx)
mirror/<sid>.json                     열린 질문 알림 사본  (교체 쓰기)
index.html, data.js                   상황판  (교체 쓰기)
published.json                        {seq, dataHash, at}  마지막 게시 번호  (render.lock 안에서만 교체 쓰기)
render.lock                           {pid, at, nonce}  게시 직렬화 잠금  (wx 생성, 끝나면 삭제)
```
- 새 파일은 `fs.writeFileSync(path, data, {flag:'wx'})`로만 만든다(덮어쓰기 없음). 교체 쓰기는 `<file>.<pid>.<rand>.tmp`에 쓴 뒤 rename하고, rename이 EPERM/EBUSY/EACCES면 20ms에서 시작해 두 배씩 늘려 최대 8번 재시도한 뒤 실패를 던지고 tmp를 지운다(근거: 같은 번들의 저장 경로가 재시도 없이 EPERM을 낸 실측, 아래 References).
- 결정 번호는 전역 단조 증가: `decisions/`의 최댓값+1로 `wx` 생성, EEXIST면 +1 재시도. 번호는 재사용하지 않고 게시된 선택지는 바꾸지 않는다.
- 오래된 잠금·선점 회수(원자적, claims와 render.lock 공통, `reclaimStale(rel, staleRecord)`): '오래됨'은 파일에 적힌 pid의 프로세스가 없을 때뿐이다(살아 있는 pid의 파일은 얼마나 오래됐든 회수하지 않음). 잠금·선점 기록에는 만들 때마다 새 무작위 `nonce`(`crypto.randomUUID()`)를 넣는다. 내용을 읽을 수 없거나 비어 있으면(막 wx로 만들어져 아직 쓰는 중일 수 있음) 살아 있는 것으로 본다. 회수 순서: (1) 방금 읽은 기록 R의 pid가 죽었는지 확인 (2) `fs.linkSync(파일, <파일>.stale-<R.nonce>)`(하드 링크, 대상이 있으면 EEXIST) (3) 만든 묘비를 읽어 pid·at·nonce가 R과 모두 같을 때만 원래 파일을 지우고(unlink) true를 돌려주며 호출한 쪽이 다시 wx로 만든다. 다르거나 읽을 수 없으면(그 사이 원래 파일이 정상 해제·되돌리기로 지워지고 남이 같은 경로에 새로 만든 경우) 방금 만든 묘비만 지우고 false (4) (2)가 EEXIST면 다른 프로세스가 같은 R을 이미 회수한 것이므로 아무것도 지우지 않고 false. false면 호출한 쪽은 처음부터 다시 읽는다. R과 일치한 묘비는 지우지 않는다. R의 묘비 이름은 하나뿐이고 지우기 전에 그 파일이 R인지 확인하므로, 남이 새로 만든 파일을 지우는 일이 없다. 하드 링크를 만들 수 없으면(EPERM·ENOTSUP 등) 회수하지 않고 '오래된 선점 - 수동 확인 필요' 오류를 던진다.
- 읽기 쪽은 깨진 JSON을 건너뛰고 카드에 '기록 읽기 실패' 표시만 한다(페이지 전체가 죽지 않음).
- 대화별 briefs는 최근 20개만 남기고 더 오래된 것은 그 대화의 확장이 새 brief를 쓴 직후 지운다(결정·답·receipt는 지우지 않음).

**`brief` 도구 입력 계약(모델이 채우는 칸, HTML은 코드가 만듬)**
```
title: string 1..40
status: 'in_progress'|'blocked'|'needs_decision'|'done'
headline: string 1..100   // 목표 기준 한 문장(체크리스트 완료가 아니라 목표 달성 여부)
changes: [{text 1..100, truth:'evidence'|'reported'|'unverified', applied:'candidate'|'live'|'none', evidence?: 절대경로}] 0..8
done:    [{text 1..100, truth, applied:'candidate'|'live'|'none', evidence?: 절대경로}] 0..12
next: string 0..100
decisions: [{id?: number /*기존 열린 결정 유지*/, question 1..100, options:{A:{text 1..60,consequence 1..80},B:{...},C?:{...}}, recommend:'A'|'B'|'C', reason 1..100, blocks:boolean}] 0..4
close_decisions?: [{id:number, reason:'superseded'|'withdrawn'}]
flow?: [{label 1..20, state:'done'|'doing'|'todo'|'blocked'}] 0..8
```
- 거절(도구 오류로 모델에 되돌려 줄여 다시 쓰게 함): 길이 초과(필드명·한도 명시, 길이는 유니코드 코드포인트), 배열 개수 초과, 상대경로 evidence, truth='evidence'인데 evidence 없음, 선택지 2개 미만, recommend가 없는 선택지를 가리킴, 존재하지 않거나 다른 세션 소유의 decisions[].id/close_decisions.id.
- 낮춰 저장(도구 결과에 경고로 알림): truth='evidence'인데 경로가 없는 파일 -> 'reported' + 플래그 `evidence_missing`. 존재하면 기록 시점 sha256을 저장하고, 렌더 때 다시 계산해 다르면 `evidence_changed`, 없으면 `evidence_gone`으로 표시(화면 단어: '증거 있음' / '증거 바뀜' / '증거 사라짐', '검증됨'이라는 단어는 쓰지 않음). 10MB를 넘는 증거는 크기+mtime으로 대신 비교.
- 상태 우선순위(카드 상태 칩): blocked > 열린 blocks=true 결정(needs_decision) > 증거 바뀜/사라짐(재확인) > done > in_progress. status='done'인데 done[]가 비거나 전부 'unverified'면 '끝(근거 없음)'으로 표시.
- 결정 카드는 8줄 고정 형식: `#12 [작업명] 질문` / `A: 선택 => 결과` / `B: ...` / `C: ...(있을 때)` / `추천: A - 이유` / `만든 대화: <제목> (<창 ID>)` / `⏱ <시각>` / `답: /decide 12A` + 복사 버튼. 추천은 자동 선택하지 않는다.

**상황판 화면 규칙**
- 왼쪽 목차 = 탭 3개(나를 기다림 / 진행 중 / 끝남, 끝남은 기본 접힘). 각 탭 아래 프로젝트 폴더명 -> 대화 카드 목록, IntersectionObserver 스크롤 스파이로 보고 있는 카드 강조, 클릭하면 이동. 상단 가로 버튼 줄은 만들지 않는다.
- '나를 기다림' = 답 없는 열린 결정 또는 blocked 또는 열린 질문 알림이 있는 대화. '끝남' = status done. 나머지 '진행 중'.
- 본문 맨 위 한 줄: `결정 대기 n · 막힘 n · 오래됨 n · ⏱ 마지막 갱신 HH:MM`, 그 아래 회색 한 줄: `브리핑이 켜진 대화 N개만 보입니다 - 설치 전부터 열려 있던 대화는 새로 열어야 나타납니다`.
- 페이지 맨 아래 범례(접힘 기본): '증거 있음 = 적어 둔 파일이 그때와 같은 내용으로 있음(다시 실행해 확인한 것은 아님)', '보고만 됨 = 에이전트가 말했을 뿐', '미확인', '후보 = 실사용에 안 올림', '적용 해당 없음 = 조사·문서처럼 실사용에 올릴 것이 없는 항목', '실사용 적용 = 에이전트가 실사용에 올렸다고 기록함', '자동 요약 = 보고 도구 없이 마지막 답에서 잘라온 것', '답 자동 줄임 = AI가 줄여 쓰지 못해 확장이 잘라 맞춘 답(나머지는 상황판)'.
- 대화 카드 첫 화면: 상태 칩 + `[작업명]` + headline 1줄 + ⏱ + 변화 최대 3행(소유자가 그 대화에 마지막으로 입력한 뒤의 brief 변화가 있으면 '새로 바뀜', 없으면 '최근 변화') + 결정 카드 최대 2장. 넘치는 것은 '외 n개' 버튼으로 접는다. 줄당 표시 내용은 입력 단계에서 100자 이내로 제한되어 있다.
- '자세히' 펼침: done 목록(진실·적용 칩, 증거 절대경로+복사), next, 흐름 그림(SVG 상자+화살표, 좋은 화면에서 1줄, 600px 미만에서 2줄), 자동 정보(작업 이름·단계, todo 현재/다음 + n/m, 작업자 실행/완료/오류 수 - '절차 진행, 목표 달성 아님' 문구 포함, 퍼센트 표기 없음).
- 칩: '작업 중'(agent_start 후 settled 전), '응답 없음'(meta.running인데 meta.pid 프로세스가 없음 - 렌더하는 프로세스가 `process.kill(pid, 0)`으로 확인), '보고 없음'(도구를 쓴 턴이 brief 없이 끝남), '오래됨'(in_progress인데 마지막 활동 6시간 이상), '기록 읽기 실패', '질문 미러 사용 불가'.
- 색: 청록=진행, 초록=끝/증거 있음, 노랑=보고만 됨/결정 대기, 빨강=막힘/증거 사라짐, 회색=미확인. 밝은 테마 기본 + prefers-color-scheme 어두운 테마.
- 외부 요청 0건: 폰트·스크립트·이미지 전부 인라인 또는 같은 폴더 파일.
- 갱신 방식은 todo 5 실측 결과를 따른다: 기본안 = 페이지가 보이는 동안(`document.visibilityState === 'visible'`)만 5초마다 `data.js?v=<n>` script 태그를 다시 넣어 `seq`를 비교하고, 더 크면 화면 오른쪽 위 '새 내용 있음' 배지만 띄운다. 배지를 누르면 현재 탭·스크롤 위치·펼친 카드를 유지한 채 다시 그린다. 대체안(기본안이 file://에서 안 될 때만) = 숨은 iframe이 보이는 동안 5초마다 `data.html?v=<n>`을 다시 읽고, data.html 안의 스크립트가 `parent.postMessage(data, '*')`로 데이터를 넘긴다(부모는 `event.source === iframe.contentWindow`인 message만 받음). 배지 동작은 기본안과 같다. 두 방식 모두 file://에서 안 되면 IS-6 미충족이므로 실행자는 멈추고 소유자에게 보고한다(수동 새로고침 안내만으로는 합격이 아님). 대체안을 고른 경우 렌더러는 data.html도 교체 쓰기로 만든다.

**확장 동작(리드 세션만)**
- 리드 판별: 세션 파일 경로가 `[/\\]senpi-task[/\\]children[/\\]`에 맞거나 `pi.sessionKind !== 'interactive'`(DOCS extensions.md 작성 시 1683행)이거나 `ctx.hasUI === false`(print·json 모드, 3637-3642행)면 아무것도 등록하지 않음(자식 작업자의 결과물이 짧아지거나 카드가 넘치는 것을 막음). 그 외 TUI·RPC는 등록. 도구·명령 등록은 session_start에서 ctx를 확인한 뒤 한다(registerTool은 시작 후에도 가능, 1790행).
- 등록: 도구 `brief`, 명령 `/brief`(자기 세션의 작업자 기록을 한 번 읽어 렌더한 뒤 index.html 열기: `C:/Program Files/Google/Chrome/Application/chrome.exe`가 있으면 `execFile(chrome, [fileUrl])`, 없으면 `execFile('explorer.exe',[path])` - explorer 종료코드 1은 무시), `/brief off`·`/brief on`(settings.json enabled, 꺼지면 규칙 주입·자동 갱신·전달 중지, 도구는 '꺼져 있음' 반환), `/brief path`(STATE·페이지 경로 출력), `/decide`.
- before_agent_start: enabled일 때만 시스템 프롬프트 끝에 보고 규칙(아래 문구, 표식 `<!-- omo-briefing-rule v1 -->`)을 표식이 없을 때 1회만 덧붙인다.
  ```
  <!-- omo-briefing-rule v1 -->
  [보고 규칙 - omo-briefing]
  - 도구를 쓴 턴은 마지막 답 전에 brief 도구를 한 번 호출해 상황판을 갱신한다.
  - 채팅 마지막 답은 짧게: 기존 하네스가 요구하는 라우팅 줄과 인계 블록 라벨은 유지하되, '사용자에게 알릴 내용' 칸은 짧은 문장 3개 이내 + '상황판: <절대경로>'. 마지막 답 전체는 빈 줄 제외 10줄·700자 이내. 자세한 내용은 brief에 둔다.
  - 소유자가 정할 것은 brief.decisions에 선택지·결과·추천·이유로 넣는다. 지금 답이 꼭 필요하면 질문 도구도 함께 쓴다.
  - 증거 파일 절대경로가 있을 때만 truth=evidence, 실사용에 반영됐을 때만 applied=live, 실사용에 올릴 것이 없는 항목(조사·문서 등)은 applied=none.
  - '[결정 전달] #N -> X' 메시지는 소유자의 답이다. 그 답은 계획 선택일 뿐 설치·푸시·삭제 승인이 아니다.
  ```
- 이벤트 기록(해당 세션 meta.json): `input`(소유자 입력) -> lastOwnerInputAt; `tool_result` -> turnDidWork=true, toolName이 `task`면 결과 문자열에서 `st_[0-9a-z]+`를 workerIds에 추가; brief 호출 -> turnBriefed=true, lastBriefAt; `agent_start` -> meta.running=true·pid=process.pid 기록 후 렌더('작업 중'); `agent_settled` -> running=false, lastActivityAt, turnDidWork && !turnBriefed면 '보고 없음' 표시 + 이번 턴 마지막 assistant 메시지에서 인계 블록 줄(`For you:`·`Now:`·`Next:`로 시작하는 줄, 각 100자로 자름)을 찾아 meta.autoSummary에 저장(카드에 '자동 요약(보고 도구 미사용)'으로 표시, 못 찾으면 '요약 없음'), 두 플래그 초기화, 렌더. turn_end에는 아무것도 하지 않는다(모델 라운드마다 발생).
- 답 길이 강제(IS-4): `agent_before_settle`(DOCS extensions.md 750행: turn_end처럼 항목 추가와 이어쓰기 1회 요청 가능, 정확한 반환 형태는 'turn_start / turn_end' 절에서 확인)에서, enabled이고 이번 실행에 도구 사용이 있었으면 마지막 assistant 답의 빈 줄 제외 줄 수·글자 수(코드포인트)·상황판 절대경로 포함 여부를 센다. 10줄 초과·700자 초과·경로 없음 중 하나라도 해당하면 같은 실행에서 한 번만 이어쓰기를 요청한다(문구: `[보고 길이] 직전 답이 길거나 상황판 경로가 없어. '상황판: <절대경로>'를 포함해 3문장 이내로 마지막 답만 다시 써. 도구는 쓰지 마.`). 이어쓰기를 요청하면 메모리 플래그 rewritePending=true(agent_settled에서 지움). `message_end`(DOCS extensions.md 작성 시 813행: `{ message }`를 돌려주면 확정된 메시지를 같은 role로 교체)에서 rewritePending이고 assistant 메시지에 도구 호출 블록이 없는데 그 답이 여전히 기준을 넘으면, text 블록들을 합친 문자열에 `fitReply(text, pagePath)`를 적용한 text 블록 1개로 바꾸고(thinking 등 다른 블록은 그대로) meta.replyTrimmed=true -> '답 자동 줄임' 칩. 이어쓴 답에 도구 호출이 있어 교체하지 못했고 두 번째 agent_before_settle에서도 마지막 답이 넘으면, 더 이어쓰기를 요청하지 않고 fitReply 결과를 `custom_message` 항목 1개(채팅에 표시, customType 'omo-briefing-reply'; 정확한 항목 형태는 SENPI types.d.ts의 `AgentBeforeSettleEvent` 선언에서 확인)로 덧붙인다(continue 없음, 805행). 그래서 채팅 맨 끝 답은 어느 분기에서도 기준 안에 든다. `fitReply`(src/rule.mjs 순수 함수): 빈 줄과 기존 '상황판:' 줄을 빼고 앞에서부터 최대 8줄을 남기며, 아래 2줄까지 합친 전체가 700 코드포인트 안에 들도록 넘치는 줄 끝을 '…'로 자르고 남는 줄은 버린다. 하나라도 잘랐거나 버렸으면 '(나머지는 상황판)' 1줄을 붙이고, 마지막 줄은 항상 '상황판: <절대경로>'. 결과는 항상 빈 줄 제외 10줄·700자 이내이고 경로를 포함한다.
- 자동 수집(읽기 전용, brief 호출·agent_settled 때만, 세션당 60초 캐시, 폴더 감시 없음): `<cwd>/.omo/boulder.json`에서 session_ids에 이 세션이 든 work(plan_name·phase·current_task·completed_tasks·task_count); `ctx.sessionManager.getBranch()`의 마지막 `senpi.todo-state`(legacy `todowrite*`·`todo-list` 포함); 작업자 수는 이 세션의 task 도구 결과·완료 알림에서 얻은 id·상태(meta.workers)로 셈다. `<cwd>/.omo/senpi-task/tasks/<id>.json` 읽기는 소유자가 `/brief`를 입력했을 때만, 그 세션의 id 파일만 한다(동시 읽기가 작업자 기록 EPERM을 만드는 실측 때문). 어느 출처든 없거나 깨지면 그 줄만 생략.
- 결정 전달: 각 리드 세션은 `STATE/answers`를 fs.watch하고 session_start·agent_settled·input 때도 훑는다. 자기 세션이 만든 결정의 답이고 receipt가 없으면: `pi.session.admitExternalMessage({delivery_id:'d<결정번호>', sender:{kind:'command_line'}, text:'[결정 전달] #12 -> A: <선택 문구> (보낸 대화: <제목>, HH:MM). 이 결정대로 진행해.', deliverAs:<한가한 세션에서 새 턴을 시작하는 값 - DOCS extensions.md 'pi.session'절과 rpc.md에서 확인>})`. 이 호출은 `ctx.isIdle()`이 참일 때만 한다(기대 kind 'started', mode immediate). 작업 중이면 호출하지 않고 메모리에 보관했다가 그 실행의 agent_settled 핸들러에서 호출한다(settled 뒤 새 턴, mode after-turn; settled 핸들러에서 요청한 실행은 모든 핸들러 뒤 시작 - DOCS 745-750행). followUp·steer로 진행 중인 실행에 끼워 넣지 않는다(작성 시 1714행: delivery_id 중복은 `already_admitted`, 소유자가 입력 중이면 `held_draft`). 결과가 started/queued/steered/already_admitted면 아직 영수증을 쓰지 않고 메모리의 '확인 대기' 목록에 넣는다(페이지 표시 '전달 중'). held_draft·turn_conflict·예외면 receipt 없이 두고 다음 깨움(answers 감시·agent_settled·input·`ctx.onUserActivity`)에 다시 시도한다. 확인 대기 항목은 agent_start·message_end·agent_settled·session_start·answers 감시 이벤트마다 `pi.session.listAdmittedDeliveries()`를 보고, emitted에 delivery_id가 있거나 세션 브랜치에 customType `session_control_delivery`이고 details.delivery_id가 그 값인 `custom_message` 엔트리가 저장돼 있을 때만(이벤트에서 전달 메시지를 본 것은 증거가 아니다 - 확장 이벤트가 저장보다 먼저 실행되고 저장이 실패하면 refused로 남는다: SENPI `core/agent-session.js` 작성 시 2154-2158·2200-2204행; 전달 메시지는 user 메시지가 아니다 - SENPI `core/external-admission.js`의 `deliveryMessage`, `core/agent-session.js`의 `appendCustomMessageEntry` 저장) receipts/<id>.json을 wx로 쓴다(proven:true; EEXIST는 이미 기록됨). failed에 있으면 그 실행이 settled된 뒤 다시 admit한다(DOCS extensions.md 작성 시 1715행). pi.session 경로에서는 proven:false 영수증을 쓰지 않는다. `pi.session`이 없는 호스트에서만 대체로 `pi.sendUserMessage(text)`를 쓰되 한가할 때만 보내고(작업 중이면 agent_settled에서) receipt에 `proven:false`. 소유 세션이 실행 중이 아니면 페이지에 '대기: 그 대화가 다시 열리면 전달'로 표시하고 그 세션의 다음 session_start에서 보낸다(mode 'on-resume').
- `/decide` 문법: 토큰 `^(\d+)([ABCabc])?$`를 공백·쉼표로 구분, 번호만 있으면 추천안. 모든 토큰을 먼저 검사(존재·닫히지 않음·답 없음·선택지 존재·중복 없음)하고 하나라도 틀리면 아무것도 쓰지 않고 문제 목록을 보여준다. 검사를 모두 통과하면 두 단계로 쓴다. (1) 선점: 번호 오름차순으로 토큰마다 claims/<id>.json을 wx로 만든다. EEXIST인데 그 선점에 답이 없고 그 pid 프로세스가 없으면 오래된 선점으로 보고 '오래된 잠금·선점 회수' 규칙(reclaimStale)으로 회수한 뒤 그 토큰만 한 번 다시 선점한다. 회수가 false이거나 재선점이 EEXIST면 다른 창이 먼저 잡은 것으로 보고 아래 '그 외의 EEXIST'와 같이 처리한다. 그 외의 EEXIST(같은 순간 다른 창이 같은 번호를 선점)면 이번에 만든 선점 파일만 지우고 answers는 하나도 쓰지 않은 채 '적용 안 함: #N 이미 답함(다른 창이 먼저)'으로 보고한다. (2) 모든 토큰을 선점한 뒤에만 answers/<id>.json을 wx로 쓴다. 답은 선점한 프로세스만 쓰므로 이 단계에서 EEXIST는 생기지 않고, 전달 감시는 answers만 보므로 두 창에서 같은 순간 답해도 한 줄의 답은 전부 적용되거나 전혀 적용되지 않는다. 2단계에서 디스크 오류 같은 예외가 나면 이미 쓴 답은 지우지 않고(이미 전달됐을 수 있음) 오류와 쓰인 번호를 그대로 보여준다(동시 입력이 아닌 장애라 IS-2 보장 범위 밖). 결과를 한 줄로 보여주고 렌더한다. 답한 대화가 결정 소유 대화면 그 자리에서 곧바로 전달 규칙을 탄다.
- 질문 알림 미러: `pi.events.on('ask-user:asked')`와 `pi.events.on('ask-user:closed')`(DOCS extensions.md 'Pending-question bus events', 작성 시 770-781행; 요청 ID는 집합으로 추적, closed의 status로 답함/시간 초과/취소 구분)로 받아 mirror/<sid>.json에 질문·선택지·HERDR_PANE_ID를 적고 '나를 기다림'에 '질문 알림 열림 - <창 ID>에서 답하기'(읽기 전용)로 보여준다. 답 없이 닫히면(시간 초과·취소) 같은 질문을 source='question-timeout' 결정 카드로 바꿔 `/decide`로 늦게도 답할 수 있게 한다. 이벤트를 받을 수 없으면 '질문 미러 사용 불가' 칩만 띄우고 나머지는 정상 동작.
- 알림: blocks=true 새 결정이 생기면 `HERDR_BIN_PATH`가 실제 파일이고 `<herdr> notification --help`가 성공할 때만 그 CLI로 알림 1회(결정 번호당 1회), 아니면 `ctx.ui.notify`가 있으면 그것, 둘 다 없으면 생략.
- 렌더(게시)는 프로세스 사이에서 직렬화한다: `render.lock`을 wx로 만들고(EEXIST면 20ms부터 두 배씩 최대 8회 재시도; 잠금 파일의 pid 프로세스가 없으면 '오래된 잠금·선점 회수' 규칙으로 회수하고 재시도, pid가 살아 있으면 오래돼도 지우지 않음), 잠금 안에서 store 전체를 읽고 `published.json`의 seq+1을 새 seq로 정해 data.js(대체안이면 data.html도)·index.html·published.json을 교체 쓰기한 뒤 잠금을 지운다. 잠금을 놓은 뒤 store 최대 mtime이 읽을 때보다 커졌으면 같은 절차로 한 번 더 게시한다. 잠금을 끝내 못 얻으면 이번 게시는 건너뛰고 meta.lastError만 남긴다(다음 이벤트에서 다시 게시). 페이지는 seq가 보고 있는 것보다 클 때만 배지를 띄운다. 최근 30일 활동 대화만 표시.

**설치·끄기**
- 설치기 `node REPO/scripts/install.mjs --agent-dir <dir> [--dry-run] [--uninstall]`: 빌드된 `REPO/dist/`를 `<dir>/briefing/integration/generation-<6자리>/`로 복사(기존 세대는 절대 수정하지 않고 다음 번호 새로 만듦), `<dir>/briefing/current.json`({generation, installedAt, sha256 목록}) 교체 쓰기, 관리 shim `<dir>/extensions/omo-briefing.js` = `// managed by omo-briefing` + `export { default } from '../briefing/integration/generation-NNNNNN/extension.mjs';`. 같은 이름의 비관리 파일이 있으면 거절. `--uninstall`은 관리 shim만 지우고 세대 폴더·STATE는 남긴다. `<dir>/extensions/`의 다른 파일은 읽지도 쓰지도 않는다.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 설치된 omo-ai·senpi 번들, `AGENT/extensions/`의 다른 파일, `AGENT/herdr-dashboard/`·`AGENT/herdr-dag/`, `AGENT/settings.json` 수정 금지.
- 새 Herdr 창·탭, 다른 창에 키 입력(`herdr pane send-*`, `herdr agent prompt`) 금지. 소유자의 열린 OMO 세션 재시작·종료·reload 금지.
- 상주 서버·로컬 웹서버·데몬·예약 작업·별도 프로세스 금지(모든 동작은 열린 pi 세션 안의 이벤트와 브라우저 페이지 안의 스크립트만).
- CDN·npm 런타임 의존성·Mermaid 등 외부 라이브러리 금지(devDependency도 추가하지 않음; 테스트는 node:test).
- 모델이 HTML·요약문을 생성하는 별도 호출 금지. 완료율(%) 표시 금지. '검증됨' 단어 금지.
- `.omo/senpi-task/tasks` fs.watch·주기적 전체 읽기 금지(workerIds 파일만, 60초 캐시).
- 질문 대화상자를 다른 창에서 답하는 기능 금지(미러는 읽기 전용).
- 기록된 결정을 설치·푸시·삭제·결제 승인으로 취급 금지.
- 시장·가격·공유 링크·로그 임포터·비용 실험(이전 Codex 플랜 범위) 금지.
- git commit·push·원격 저장소 생성·git config 변경 금지(`git init`까지만. 커밋은 소유자가 따로 승인한 뒤 `REPO` 로컬에만).

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **TDD** (소유자 선택 Q2=A) + `node:test`(`node --test --test-isolation=none test/*.test.mjs`, Node >= 24, 외부 테스트 라이브러리 없음). 각 todo는 실패하는 테스트를 먼저 쓰고 구현해 통과시킨다. 시간 대기(sleep) 없이 이벤트·파일 생성을 구독한 뒤 동작을 일으키고 제한 시간 안에 기다린다.
- 실제 화면: 브라우저 스킬(omowright, 소유 Chrome)로 `file:///.../index.html`을 열고 1440x900과 390x844에서 캐처한다. 스킬 문서 `C:/Users/USER/.bun/install/global/node_modules/omo-ai/plugin/skills/browser/SKILL.md`. Chrome: `C:/Program Files/Google/Chrome/Application/chrome.exe`(존재 확인됨).
- 실제 pi: 격리 실행은 `pi --mode rpc -e <REPO>/dist/extension.mjs`(README `-e, --extension` 650행) + 환경변수 `OMO_BRIEFING_STATE_DIR=<임시 폴더>` + 임시 cwd로 하고, HERDR_* 환경변수는 지운다. RPC 명령은 `DOCS/rpc.md`를 따른다. 실제 구독·기본 모델 프롬프트는 전체 QA에서 최대 4회(확장이 요청하는 길이 줄이기 이어쓰기는 프롬프트당 최대 1회 추가), 새 유료 서비스 없음. 모델이 쓴 문장 내용은 합격 기준이 아니다(도구 호출·이벤트·파일, 그리고 IS-4의 마지막 답 줄 수·글자 수·경로 포함 여부만 기계로 판정).
- `EV`: ulw-loop 안이면 아래 attemptDir, 밖이면 `C:/Users/USER/orca/projects/기타 작업/.omo/evidence/piomo-living-briefing/`. 파일명은 `task-번호-설명.txt`(또는 .png/.json), 각 todo의 QA가 정확한 이름을 준다.
- Evidence: 파일 이름은 `EV/task-번호-설명.확장자`. ulw-loop 안의 EV(attemptDir = result.currentAttemptDir from await agentToolkit.status() in a JS eval cell after importing agentToolkit with await import(`${env("OMO_AGENT_TOOLKIT_SDK_ROOT")}/sdk.js`), .omo/evidence/ulw/<session>/<goalId>/a<attempt>; outside ulw-loop use .omo/evidence/)

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1 (기초, 병렬): 1 저장소 뼈대, 2 입력 계약 검사기, 3 진실·상태 판정기, 4 파일 저장소, 5 file:// 갱신 실측. (2·3·4·5는 1의 package.json만 필요 - 1을 먼저 끝내고 나머지를 병렬)
- Wave 2: 6 페이지 템플릿, 7 렌더러, 8 자동 수집기, 9 `/decide` 처리기, 13 설치기.
- Wave 3: 10 확장 진입점, 11 결정 전달, 12 질문 알림 미러.
- Wave 4: 14 격리 실제 pi 통합 시험, 16 사용 안내서, 그다음 15 실사용 설치(14 통과 후).
- 그 뒤 Final verification wave F1~F4.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | 없음 | 2,3,4,5,6,7,8,9,13 | 없음 |
| 2 | 1 | 7,10 | 3,4,5 |
| 3 | 1 | 7,10 | 2,4,5 |
| 4 | 1 | 7,8,9,10,11,12 | 2,3,5 |
| 5 | 1 | 6 | 2,3,4 |
| 6 | 5 | 7 | 8,9,13 |
| 7 | 2,3,4,6 | 10 | 8,9,13 |
| 8 | 4 | 10 | 6,7,9,13 |
| 9 | 4 | 10,11 | 6,7,8,13 |
| 10 | 2,3,4,7,8,9 | 11,12,14 | 없음 |
| 11 | 9,10 | 14 | 12 |
| 12 | 10 | 14 | 11 |
| 13 | 1 | 15 | 6,7,8,9 |
| 14 | 10,11,12 | 15 | 16 |
| 15 | 13,14 | F1-F4 | 없음 |
| 16 | 10 | F1-F4 | 14 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. 새 소스 저장소 뼈대와 빌드·테스트 명령 만들기
  Recommended task executor category: quick - 파일 뼈대와 짧은 빌드 스크립트뿐이다.
  What to do / Must NOT do: `REPO`를 만들고(이미 있으면 중단하고 보고) `git init`. `package.json` = {name:'omo-briefing', private:true, type:'module', engines:{node:'>=24'}, scripts:{test:'node --test --test-isolation=none test/*.test.mjs', build:'node scripts/build.mjs', check:'npm test && npm run build'}}, dependencies 없음. 빈 모듈 파일: `extension.mjs`, `src/{schema,truth,store,render,collect,decide,deliver,mirror,rule,open-page}.mjs`, `src/page/{view.js,page.js,page.css}`(브라우저용은 classic script - file://에서 ES module이 막히므로), `scripts/{build.mjs,install.mjs}`, `test/`, `.gitignore`(dist/, node_modules/, .dist-stage-*). `build.mjs`: `.dist-stage-<pid>`에 extension.mjs·src/·scripts/install.mjs를 복사하고 모든 .mjs/.js에 `node --check`, 모두 통과해야 dist/를 교체(실패하면 기존 dist 유지, stage 삭제, exit 1). 외부 패키지 설치 금지.
  Closes: GAP-7
  Parallelization: Wave 1 | Blocked by: 없음 | Blocks: 2,3,4,5,6,7,8,9,13
  References (executor has NO interview context - be exhaustive): 빌드 방식 선례 `C:/Users/USER/.omo-stable-500/home/.omo/memory/agents/기타-작업-a6d9316b/repo/reference/engineering/omo-herdr-dag-viewer.md` '빌드·테스트' 절; Node `C:/Program Files/nodejs/node.exe`(v24).
  Acceptance criteria (agent-executable): `npm test`와 `npm run build`가 REPO에서 exit 0; `REPO/dist/extension.mjs` 존재; `test/build.test.mjs`가 깨진 .mjs가 있는 임시 복사본에서 build exit 1 + 기존 dist 바이트 유지를 단언하고 통과.
  QA scenarios (name the exact tool + invocation): happy - PowerShell `cd REPO; npm run check` 출력을 EV/task-1-check.txt. failure - `node --test test/build.test.mjs` 출력(깨진 파일 -> exit 1, dist 유지)을 EV/task-1-broken-build.txt.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | chore(repo): scaffold omo-briefing with build and test commands

- [x] 2. brief 입력 계약·길이 예산 검사기 만들기 (src/schema.mjs)
  Recommended task executor category: quick - 표 기반 규칙과 단위 테스트다.
  What to do / Must NOT do: `validateBrief(input, {fileExists, sha256})` -> `{ok, errors[], warnings[], normalized}`. 규칙은 Scope 'brief 도구 입력 계약'을 그대로(길이 = `[...s].length`, 절대경로 = `/^[A-Za-z]:[\\/]/`, 거절 목록·낮춰 저장·evidence sha256 기록). 오류 문구는 한국어로 필드 경로와 한도를 포함(예: `changes[2].text: 100자 초과(123)`). fs 접근은 주입된 함수로만.
  Closes: GAP-3, GAP-4
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 7,10
  References (executor has NO interview context - be exhaustive): 이 플랜 Scope 'Must have' > 'brief 도구 입력 계약'; 이전 계획의 자기보고/확인 분리 `C:/Users/USER/Documents/Codex/2026-10-14/task-3/.omo/plans/agent-project-briefing-20261013.md` '상태와 신뢰' 절.
  Acceptance criteria (agent-executable): `node --test test/schema.test.mjs` 통과, 최소 케이스: 정상 전체 입력; 한글 100자 통과·101자 거절; 배열 개수 초과; `./a.txt`·`a\\b` 거절, `C:\\x\\y.txt`·`C:/x/y.txt` 허용; truth=evidence인데 경로 없음 거절; 없는 증거 파일 -> warning + truth 'reported' + `evidence_missing`; 선택지 1개 거절; recommend 'C'인데 C 없음 거절; changes[]·done[] 항목에 applied가 없거나 허용 값이 아니면 거절.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/schema.test.mjs` 전체 통과 출력 EV/task-2-schema.txt. failure - 같은 출력 안의 거절 케이스들이 필드명과 한도를 담은 오류를 내는지 단언(같은 파일).
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(schema): validate brief input with length budgets and truth downgrade

- [x] 3. 진실 표시·카드 상태·신선도 판정기 만들기 (src/truth.mjs)
  Recommended task executor category: quick - 순수 함수와 표 기반 테스트다.
  What to do / Must NOT do: `recheckEvidence(item, {stat, sha256})`(없음 -> evidence_gone, 해시 다름 -> evidence_changed, 10MB 초과는 크기+mtime 비교), `cardStatus(session, now)`(우선순위 blocked > 열린 blocks=true 결정 > 증거 바뀜/사라짐 > done > in_progress; done인데 근거 없으면 '끝(근거 없음)'), `chips(session, now)`('보고 없음' = meta.noReport, '오래됨' = in_progress && now-lastActivityAt >= 6h, '기록 읽기 실패', '질문 미러 사용 불가'), `tabOf(...)`('나를 기다림'/'진행 중'/'끝남' 규칙은 Scope '상황판 화면 규칙'). '검증됨' 문자열을 만들지 않는다.
  Closes: GAP-3, GAP-5
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 7,10
  References (executor has NO interview context - be exhaustive): 이 플랜 Scope '낮춰 저장'·'상태 우선순위'·'상황판 화면 규칙'.
  Acceptance criteria (agent-executable): `node --test test/truth.test.mjs` 통과. 우선순위 모든 인접 쌍, 증거 바뀜이 done을 이김, in_progress 7시간 -> '오래됨', 5시간 -> 없음, noReport -> '보고 없음', 출력 어디에도 '검증됨'·'%' 없음.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/truth.test.mjs` 출력 EV/task-3-truth.txt. failure - 같은 테스트의 '증거 사라짐'(임시 파일 삭제 후 recheck) 케이스 통과 확인.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(truth): card status precedence, evidence recheck and freshness chips

- [x] 4. 파일 저장소 만들기: 새 파일 쓰기·재시도 교체·결정 번호 (src/store.mjs)
  Recommended task executor category: deep-low - 다중 프로세스 동시성과 Windows rename 경합을 시험으로 닫아야 한다.
  What to do / Must NOT do: `openStore(root, {fs?})` -> {writeNew(rel,obj) (wx), replace(rel,data) (tmp+rename, EPERM/EBUSY/EACCES 20ms 시작 2배 최대 8회, 실패 시 tmp 삭제 후 throw), readSnapshot() (저장소 배치 전부 + readErrors[] + maxMtime), allocDecisionId() (최댓값+1 wx, EEXIST면 +1), reclaimStale(rel, staleRecord) (Scope '오래된 잠금·선점 회수': 묘비 하드 링크에 성공하고 묘비 내용이 staleRecord와 같을 때만 unlink, 성공 여부 반환), readSettings()/writeSettings()}. 폴더는 처음 쓸 때 만든다. `.omo/senpi-task`는 이 모듈이 절대 다루지 않는다.
  Closes: GAP-5, GAP-7
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 7,8,9,10,11,12
  References (executor has NO interview context - be exhaustive): 저장소 배치·쓰기 규칙 = 이 플랜 Scope 'Must have' 첫 표; EPERM 실측 `C:/Users/USER/.omo-stable-500/home/.omo/memory/agents/기타-작업-a6d9316b/repo/notes/facts/2026-10-15-task-record-eperm-root-cause-and-hyperplan-workaround.md`(재시도 없는 rename이 동시 읽기에서 ~41% 실패).
  Acceptance criteria (agent-executable): `node --test test/store.test.mjs` 통과: wx가 덮어쓰기를 거부; reclaimStale 결정적 끼어들기: 죽은 pid의 파일 F를 A·B가 같은 내용으로 읽은 상태에서 A가 회수(true)하고 새 F를 wx로 만든 뒤 B가 같은 staleRecord로 회수 시도 -> B는 false, A의 새 F 내용 그대로, 묘비 1개; 정상 해제 끼어들기: B가 A의 F를 읽은 뒤 A가 정상 해제(unlink, 묘비 없음)하고 A의 pid는 죽은 것으로 주입, C가 같은 경로에 새 F를 wx로 만든 뒤 B가 A의 기록으로 회수 시도 -> B는 false, C의 F 내용 그대로, `.stale-*` 묘비 0개; 비어 있는 F는 회수하지 않음; 살아 있는 pid의 파일은 회수 안 함; 주입 fs의 linkSync가 EPERM이면 F를 지우지 않고 오류; 주입 fs에서 rename 3회 EPERM 후 성공; 9회 연속 실패 시 throw + tmp 없음; 자식 프로세스 4개가 같은 임시 root에서 25개씩 allocDecisionId -> 100개 모두 서로 다름; 깨진 JSON은 readErrors에 들어가고 나머지는 읽힘; writer 자식 프로세스 2개가 같은 파일에 replace 각 500회 + reader 프로세스 1개가 writer가 replace를 마칠 때마다 보내는 IPC 메시지(부모가 중계)와 fs.watch 이벤트를 받을 때마다 즉시 읽기(고정 간격 폴링·sleep 없음; 각 writer는 끝에 'done'을 보내고 부모는 두 'done'과 reader의 마지막 읽기 응답을 제한 시간 120초 안에 기다림) -> 실패 0, 최종 내용은 두 writer의 마지막 값 중 하나이고 깨진 읽기 0(이 스트레스는 Node로 실행하고, `AGENT/runtime/<id>/runtime-snapshot.json`이나 pi 실행 파일이 Bun 런타임을 가리키면 `C:/Users/USER/.bun/bin/bun.exe`로도 실행); 대화별 brief 21번째를 쓰면 가장 오래된 1개가 지워짐.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/store.test.mjs` 출력 EV/task-4-store.txt. failure - 같은 출력의 '9회 연속 EPERM -> throw, tmp 남지 않음' 케이스.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(store): exclusive-create records, retrying replace and monotonic decision ids

- [x] 5. file:// 페이지 자동 갱신 방식 실측하기 (Chrome)
  Recommended task executor category: deep-low - 실제 브라우저 동작을 재고 두 방식 중 하나를 근거로 고른다.
  What to do / Must NOT do: `REPO/test/fixtures/refresh-spike/`에 index.html(classic script)과 data.js(`window.__briefData && window.__briefData({seq:1})`)를 두고, 브라우저 스킬의 소유 Chrome으로 file://로 연다. 페이지는 1초마다 `data.js?v=<증가값>` script 태그를 넣고 예전 태그를 지운다. 스크롤을 600px 내린 뒤 디스크의 data.js를 seq 2로 바꾼다. 확인: (a) 5초 안에 페이지가 seq 2를 봄(로드 때 정한 전역 표식이 그대로 = 새로고침 없음), (b) scrollY 600 유지, (c) `navigator.clipboard.writeText` 버튼 클릭 성공 여부와 실패 시 `document.execCommand('copy')` 성공 여부, (d) data.js를 지워도 페이지가 마지막 내용을 유지하고 콘솔 오류 외 화면 변화 없음. 결과를 `REPO/docs/refresh-decision.md`에 '기본안(script 재삽입)' 또는 '대체안(iframe+postMessage)' 한 줄과 증거 경로로 적는다. 기본안의 (a) 또는 (b)가 실패하면 같은 (a)(b)(d) 절차를 Scope의 iframe 대체안(fixture에 data.html 추가)으로 반복한다. 로컬 서버를 띄우지 않는다.
  Closes: GAP-5
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 6
  References (executor has NO interview context - be exhaustive): 브라우저 스킬 `C:/Users/USER/.bun/install/global/node_modules/omo-ai/plugin/skills/browser/SKILL.md`; Chrome `C:/Program Files/Google/Chrome/Application/chrome.exe`; 갱신 규칙 = Scope '상황판 화면 규칙' 마지막 항목.
  Acceptance criteria (agent-executable): EV/task-5-refresh.json에 `{primaryWorks, seqObserved, scrollKept, fallbackWorks, fallbackScrollKept, clipboard:'api'|'execCommand'|'none', survivesMissingData}`가 있고, refresh-decision.md의 선택이 그 값과 일치(primaryWorks && scrollKept면 기본안, 아니면 fallbackWorks && fallbackScrollKept일 때 대체안, 둘 다 아니면 todo 5 실패 - 'IS-6 미충족'으로 중단·보고).
  QA scenarios (name the exact tool + invocation): happy - 브라우저 스킬 eval 셀에서 위 (a)(b)(c) 실행, 전후 스크린샷 EV/task-5-before.png, task-5-after.png. failure - (d) data.js 삭제 후 fixture 페이지가 노출하는 갱신 시도 카운터(`window.__briefPolls`)가 2 증가하기를 제한 시간 20초 안에 기다린 뒤 화면 유지 스크린샷 EV/task-5-missing-data.png.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | docs(page): record file:// refresh mechanism decision with evidence

- [x] 6. 상황판 화면 만들기: 보기 함수·탭·목차·카드·배지·흐름 그림 (src/page/*)
  Recommended task executor category: visual-engineering - 소유자 UI 선호를 실제 화면으로 맞추는 일이다.
  What to do / Must NOT do: `view.js`(classic, `globalThis.BriefView.renderApp(viewModel, uiState) -> html 문자열`, 순수 함수, 모든 텍스트 HTML 이스케이프), `page.js`(classic: 왼쪽 목차 탭 3개 전환, IntersectionObserver 스크롤 스파이, '외 n개' 펼침, '자세히' 펼침, 복사 버튼(todo 5에서 되는 방식), todo 5 결정에 따른 갱신(기본안: 5초 주기 script 재삽입 + '새 내용 있음' 배지, 눌러야 탭·스크롤·펼침 유지한 채 반영 / 대체안: 숨은 iframe + postMessage, 배지 동작 동일)), `page.css`(빽빽한 카드, 색 규칙, 밝은/어두운 테마, 600px 미만에서 목차 접힘 버튼). 흐름 그림은 view.js가 SVG로 직접 그린다(최대 8칸). 화면 규칙은 Scope '상황판 화면 규칙'과 '결정 카드 8줄' 그대로. 상단 가로 버튼 줄·외부 폰트·CDN·이모지 아이콘 남발 금지(⏱·• 같은 기호는 허용).
  Closes: GAP-1, GAP-2, GAP-5
  Parallelization: Wave 2 | Blocked by: 5 | Blocks: 7
  References (executor has NO interview context - be exhaustive): 소유자 UI 선호 `C:/Users/USER/.omo-stable-500/home/.omo/memory/agents/기타-작업-a6d9316b/repo/system/human.md`의 'PREFERENCE (문서/UI)'·'PREFERENCE (대시보드 카드 가독성, 2026-10-14)'·'PREFERENCE (결정 요청)' 줄; `REPO/docs/refresh-decision.md`(todo 5); 보기 모델 필드는 todo 7과 공유하므로 `REPO/test/fixtures/view-model.json`을 이 todo에서 먼저 만든다(프로젝트 3개, 대화 6개, 열린 결정 5개, 변화 5행인 대화 1개, 열린 질문 알림 1개, 오래됨·보고 없음 각 1개).
  Acceptance criteria (agent-executable): `node --test test/view.test.mjs`(view.js를 `vm.runInNewContext`로 실행) 통과: 카드당 변화 행 <=3·결정 카드 <=2·'외 n개' 숫자 일치; 왼쪽 목차에 탭 3개; 본문 맨 위에 가로 버튼 줄 요소 없음; 결정 카드 8개 논리 줄과 `/decide 12A` 복사값; 진실 칩 문구 3종과 변화 행·완료 행 모두의 적용 칩(applied 'candidate'='후보', 'live'='실사용 적용', 'none'='적용 해당 없음' - 모든 행에 셋 중 하나가 반드시 있고 칩 없는 행 0개); '검증됨'·'%'·'http' 문자열 없음; headline의 `<script>`가 이스케이프됨.
  QA scenarios (name the exact tool + invocation): happy - 브라우저 스킬로 fixture를 넣은 페이지를 1440x900·390x844 캐처(EV/task-6-desktop.png, task-6-narrow.png)하고, 탭 클릭·목차 클릭 이동·스크롤 스파이 강조 변화의 DOM 상태를 EV/task-6-interactions.json에 기록. failure - 빈 보기 모델(대화 0개)과 읽기 실패 칩이 있는 모델에서 '아직 보고 없음' 화면과 칩이 뜨는 캐처 EV/task-6-empty.png.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(page): sidebar tabs, dense cards, decision cards, badge refresh and flow svg

- [x] 7. 렌더러 만들기: 저장소 -> 보기 모델 -> index.html·data.js (src/render.mjs)
  Recommended task executor category: unspecified-high - 여러 모듈 계약을 모으는 표준 기능 구현이다.
  What to do / Must NOT do: `buildViewModel(snapshot, now)`: 최근 30일 활동 대화, 프로젝트(cwd 폴더명)별 그룹, 탭 배정(todo 3), 정렬('나를 기다림'은 가장 오래된 열린 결정 순, 안에서는 결정 번호 순; 나머지는 최근 활동 순), 최신 brief, lastOwnerInputAt 이후 변화('새로 바뀜') 아니면 최신 brief 변화('최근 변화'), 소유 열린 결정(답 없고 닫히지 않음), 답한 결정의 전달 상태('전달됨 ⏱HH:MM' / '전달 중'(admit됐지만 기록 확인 전) / '대기: 그 대화가 다시 열리면 전달' / '대기: 작업이 끝나면 전달'), 질문 미러, meta.auto 자동 정보, 칩, 본문 위 합계 줄. `renderPage(store, now)`: index.html = 셸(인라인 page.css·view.js·page.js + 인라인 초기 데이터, `</script` 이스케이프) 교체 쓰기, data.js = todo 5 방식의 데이터 파일 교체 쓰기, 게시 직렬화(render.lock)·seq(published.json)·재게시 규칙은 Scope '렌더(게시)' 그대로.
  Closes: GAP-1, GAP-5, GAP-6
  Parallelization: Wave 2 | Blocked by: 2,3,4,6 | Blocks: 10
  References (executor has NO interview context - be exhaustive): Scope '저장소 배치'·'상황판 화면 규칙'; `REPO/test/fixtures/view-model.json`(todo 6); `REPO/docs/refresh-decision.md`(todo 5).
  Acceptance criteria (agent-executable): `node --test test/render.test.mjs` 통과: fixture 저장소(프로젝트 3·대화 6)에서 탭·정렬·그룹이 기대값과 같음; lastOwnerInputAt 전후 변화 구분; 답+receipt 있음 -> '전달됨', 답만 -> '대기'; data.js가 `vm`에서 오류 없이 실행되고 seq가 증가; headline에 `</script>` 넣어도 index.html의 script 태그 수 불변; 31일 전 대화는 제외; 동시성: 자식 프로세스 2개가 각자 다른 대화의 brief를 쓰고 renderPage를 50회씩 동시에 호출 -> 게시된 seq 전체가 중복 없이 증가(각 게시 seq를 테스트 로그에 기록), 마지막 data.js에 두 대화의 최신 brief가 모두 있음; pid가 죽은 render.lock이 남아 있어도 다음 게시가 reclaimStale로 회수하고 성공; pid가 살아 있는 render.lock은 지우지 않고 재시도 끝에 이번 게시를 건너뜀(lastError 기록); 정상 해제 뒤 다른 프로세스가 새로 잡은 render.lock은 앞서 읽어 둔 죽은 pid 기록으로 늦게 온 회수 시도가 지우지 않음(같은 순서를 이 파일에서 1회 결정적으로 재현).
  QA scenarios (name the exact tool + invocation): happy - `node --test test/render.test.mjs` 출력 EV/task-7-render.txt + fixture로 렌더한 index.html을 브라우저 스킬로 열어 1440 캐처 EV/task-7-page.png. failure - 깨진 brief JSON 1개가 섞인 저장소에서 렌더가 성공하고 해당 카드에 '기록 읽기 실패' 칩이 있는지 단언(같은 테스트 파일).
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(render): view model from store and atomic page/data output

- [x] 8. 자동 수집기 만들기: 작업 기록·todo·작업자 요약 (src/collect.mjs)
  Recommended task executor category: quick - 읽기 전용 파서와 fixture 테스트다.
  What to do / Must NOT do: `collectAuto({cwd, sessionId, branchEntries, workerIds, readFile, now, cache})` -> `{work?:{name,phase,current,done,total}, todo?:{current,next,done,total}, workers?:{running,completed,error,other}}`. work = `<cwd>/.omo/boulder.json`의 works 중 session_ids에 sessionId가 든 것(plan_name, phase, current_task, completed_tasks 길이 또는 숫자, task_count). todo = branchEntries를 뒤에서부터 훑어 처음 만나는 customType `senpi.todo-state`(또는 `todowrite`로 시작하는 것, `todo-list`)의 phases에서 in_progress 항목=current, 다음 pending=next, terminal(completed|abandoned|cancelled) 수/전체. workers = 기본은 인자 `metaWorkers`(이 세션의 task 도구 결과·완료 알림에서 todo 10이 모은 {id,status})로 개수를 센다. 옵션 `readTaskRecords:true`(오직 `/brief` 명령 경로)일 때만 workerIds에 있는 `<cwd>/.omo/senpi-task/tasks/<id>.json`을 읽어 상태를 갱신한다. 같은 sessionId는 60초 안에 다시 읽지 않고 cache 반환. 폴더 목록 읽기·fs.watch 금지. 출처가 없거나 깨지면 그 키만 생략.
  Closes: GAP-6
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 10
  References (executor has NO interview context - be exhaustive): todo 저장 계약 `C:/Users/USER/.omo-stable-500/home/.omo/memory/agents/기타-작업-a6d9316b/repo/reference/engineering/omo-todo-state-contract.md`; boulder 실제 형태 `C:/Users/USER/orca/projects/기타 작업/.omo/boulder.json`(읽기만, works.<id>.{plan_name,phase,current_task,completed_tasks,task_count,session_ids}); 작업자 기록 필드 `C:/Users/USER/orca/projects/기타 작업/.omo/senpi-task/tasks/st_01a13bda.json`(읽기만, status·parent_session_id). fixture는 이 파일들에서 필요한 필드만 손으로 옮겨 `REPO/test/fixtures/collect/`에 둔다(실제 내용 복사 금지).
  Acceptance criteria (agent-executable): `node --test test/collect.test.mjs` 통과: work 매칭; todo 최신 엔트리 우선·legacy 인식; readTaskRecords 없이 호출하면 readFile 스파이가 `senpi-task` 아래 경로를 0회 읽음, readTaskRecords:true면 workerIds 파일만 읽음; 60초 안 두 번째 호출은 readFile 0회; 파일 없음·깨진 JSON에서 예외 없이 키 생략.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/collect.test.mjs` 출력 EV/task-8-collect.txt. failure - 같은 출력의 '깨진 boulder.json -> work 없음, 나머지 정상' 케이스.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(collect): read-only work, todo and worker summaries

- [x] 9. `/decide` 처리기 만들기: 문법·전부 아니면 전무 검사·답 기록 (src/decide.mjs)
  Recommended task executor category: quick - 파서와 검사 규칙이다.
  What to do / Must NOT do: `parseDecide(text)`와 `applyDecide(store, text, fromSessionId, now)` -> `{applied:[{id,option}], errors:[{token,reason}], alreadyAnswered:[id]}`. 규칙은 Scope '`/decide` 문법' 그대로(토큰 형식, 번호만 -> 추천안, 검사 단계 전부 아니면 전무, 선점(claims) 단계 EEXIST면 이번 선점만 되돌리고 answers 0개, 답 없고 pid가 죽은 오래된 선점은 store의 reclaimStale로 회수한 뒤 재선점, 회수 false면 이미 답함). 결과 한 줄 문구 생성 함수 `formatDecideResult(result)`도 여기서(예: `반영: #12 A, #13 B` / `적용 안 함: #99 없음, #12 이미 답함`).
  Closes: GAP-2
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 10,11
  References (executor has NO interview context - be exhaustive): Scope '`/decide` 문법'; 저장소 API(todo 4).
  Acceptance criteria (agent-executable): `node --test test/decide.test.mjs` 통과: `12A 13b`, `12`(추천안), `12A,13B` 성공; `12D`·`x`·없는 번호·닫힌 번호·이미 답한 번호·`12A 12B`(중복)가 하나라도 있으면 answers/에 파일 0개; 선점 단계에서 한 토큰에 살아 있는 pid의 EEXIST 주입 -> answers 0개·이번에 만든 claims 0개·그 토큰 alreadyAnswered; 답 없는 claims 파일의 pid가 죽은 프로세스면 그 번호를 정상 적용; 동시성: 자식 프로세스 2개가 부모의 IPC 시작 신호를 받은 즉시 각각 `12A 13B`와 `13A 14B`를 적용(새 저장소로 20회 반복) -> 매회 한쪽은 두 답 모두, 다른 쪽은 0개, answers/13은 정확히 1개, 진 쪽의 다른 번호(12 또는 14) answers 파일 없음; 같은 오래된 선점 동시 회수: 죽은 pid의 답 없는 claims/12.json을 미리 둔 새 저장소에서 자식 2개가 IPC 시작 신호로 동시에 `12A 13B`와 `12B 14A`를 적용(20회 반복) -> 매회 정확히 한쪽만 두 답 모두 적용, 다른 쪽은 answers 0개·자기가 만든 claims 0개, answers/12는 1개이고 claims/12.json의 pid는 이긴 쪽, `claims/12.json.stale-*` 묘비 1개; 결정적 끼어들기: 오래된 선점을 읽은 뒤 회수 직전에 멈추게 한 B(테스트 훅)가 A의 회수·재선점·답 쓰기가 끝난 뒤 재개 -> B는 '이미 답함'으로 0개 적용, answers/12는 A의 것, A의 claims/12.json 그대로; 되돌리기 끼어들기: B가 A의 선점(claims/12.json)을 읽은 뒤 A가 다른 번호 충돌로 자기 선점을 되돌리고(삭제) 끝나며 C가 12를 새로 선점·답 쓰기 -> 그다음 B의 회수는 false, C의 claims/12.json·answers/12 유지, B는 '이미 답함'으로 0개 적용.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/decide.test.mjs` 출력 EV/task-9-decide.txt. failure - 같은 출력의 `12A 99B` -> 파일 0개 케이스.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(decide): all-or-nothing decide parsing and answer records

- [x] 10. pi 확장 진입점 만들기: 리드 판별·brief 도구·명령·규칙 주입·이벤트 기록 (extension.mjs, src/rule.mjs, src/open-page.mjs)
  Recommended task executor category: unspecified-high - 하네스 확장 API에 여러 모듈을 연결하는 다파일 기능이다.
  What to do / Must NOT do: 먼저 `DOCS/extensions.md`의 'Available Imports', 'pi.registerTool', 'pi.registerCommand', 'before_agent_start'(반환으로 systemPrompt를 바꾸는 방법), 'input', 'tool_result', 'agent_settled', 'session_start', 'session_shutdown', 'ctx.sessionManager' 절을 읽고 실제 필드명을 확인해 코드에 주석으로 줄 제목을 남긴다(세션 ID·세션 파일 경로를 얻는 함수는 `DOCS/session-format.md`에서 확인). 리드 판별·등록 목록·규칙 문구(`src/rule.mjs`에 상수로)·이벤트 기록·`/brief` 명령들은 Scope '확장 동작' 그대로. brief 실행 = 검사(todo 2) -> 결정 번호 할당·closures -> briefs/<seq> wx -> 자동 수집(todo 8) -> meta 교체 -> 렌더(todo 7) -> 결과 문구 `상황판 갱신됨: <STATE>/index.html (새 결정 #12)` + 경고. `/decide`는 todo 9 호출 후 렌더하고 결과 한 줄을 `ctx.ui.notify`(없으면 명령 출력)로 보여준다(전달은 todo 11). setInterval 같은 주기 작업 금지. 오류는 삼키지 않고 meta의 lastError + 칩으로 남긴다.
  Closes: GAP-4, GAP-5, GAP-7
  Parallelization: Wave 3 | Blocked by: 2,3,4,7,8,9 | Blocks: 11,12,14,16
  References (executor has NO interview context - be exhaustive): `DOCS/extensions.md` 제목 'Extension Locations'(작성 시 148행), 'before_agent_start'(677), 'agent_settled'(745), 'tool_result'(1095), 'input'(1160), 'ctx.sessionManager'(1245), 'pi.registerTool'(1786), 'pi.registerCommand'(2087); `SENPI/extensions/types.d.ts`(sendUserMessage 657·1847·1891); 자식 세션 제외 규칙 `C:/Users/USER/.omo-stable-500/home/.omo/memory/agents/기타-작업-a6d9316b/repo/reference/engineering/omo-herdr-dag-viewer.md` '로딩 게이트'; 설치된 확장 예시 `AGENT/extensions/omo-herdr-dashboard.js`.
  Acceptance criteria (agent-executable): `node --test test/extension.test.mjs`(가짜 pi 객체가 registerTool/registerCommand/on 호출을 기록) 통과: 자식 경로 세션·sessionKind 'worker'·hasUI=false -> 등록 0건; 리드 -> 도구 brief + 명령 brief·decide; agent_start -> meta.running·pid; brief 없이 끝난 턴의 마지막 답에 `For you:`/`Now:`/`Next:` 줄이 있으면 meta.autoSummary, 없으면 '요약 없음'; task 도구 결과·완료 알림 문자열에서 id와 상태(running/completed/error/cancelled)를 meta.workers에 반영; agent_settled 경로에서 `senpi-task` 파일 읽기 0회(스파이); before_agent_start 2회 후 표식 1회; enabled=false -> 주입 없음 + brief가 '꺼져 있음' 반환; task 도구 결과 문자열의 `st_abc123` -> meta.workerIds; 도구를 쓴 턴이 brief 없이 agent_settled -> noReport; 임시 STATE에서 brief 실행 후 index.html·data.js·decisions/000001.json 존재; agent_before_settle: 도구를 쓴 실행의 15줄 답 -> 이어쓰기 요청 1회(문구 일치), 이어쓴 답(도구 호출 없음)이 15줄 -> message_end가 바꾼 답이 빈 줄 제외 10줄 이하·700자 이하·마지막 줄 경로, 추가 이어쓰기 요청 0회, meta.replyTrimmed=true; 이어쓴 답에 도구 호출이 있고 두 번째 agent_before_settle에서도 마지막 답이 넘음 -> fitReply 결과의 custom_message 1개 덧붙임(continue 없음)이고 그 내용이 기준 안; rewritePending이 아닐 때 message_end는 메시지를 바꾸지 않음; fitReply 단위: 30줄·2000자·경로 없음 -> 10줄·700자 이내·마지막 줄 경로, 1줄 900자 -> 700자 이내·경로 포함, 기준 안이고 마지막 줄이 경로인 입력 -> 그대로, 8줄·경로 포함 -> 0회, 8줄이지만 경로 없음 -> 1회, 도구를 안 쓴 실행 -> 0회, enabled=false -> 0회; `npm run build` 후 `node --check dist/extension.mjs` 통과.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/extension.test.mjs` 출력 EV/task-10-extension.txt. failure - 같은 출력의 '길이 초과 brief -> 저장 0건·오류 문구에 필드명' 케이스.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(extension): brief tool, commands, rule injection and session event bookkeeping

- [x] 11. 결정 전달 만들기: 소유 대화가 답을 받아 진행 + 영수증 + 알림 (src/deliver.mjs)
  Recommended task executor category: deep-low - 여러 프로세스 사이 중복 전달 방지와 한가/작업 중 분기를 닫아야 한다.
  What to do / Must NOT do: Scope '결정 전달' 그대로. 전달은 `pi.session.admitExternalMessage`(delivery_id `d<번호>`)가 기본이고 결과 kind별 처리·receipt·증명(customType `session_control_delivery`인 `custom_message` 엔트리 또는 `listAdmittedDeliveries().emitted`)은 Scope '결정 전달' 그대로. 예외나 held_draft면 meta.lastError/대기 사유를 기록하고 다음 깨움에 재시도. 깨움 = `STATE/answers` fs.watch(이 폴더만), session_start, agent_settled, input, `ctx.onUserActivity`. `pi.session`이 없을 때만 sendUserMessage 대체(Scope 참조). 새 blocks=true 결정 알림은 Scope '알림' 규칙. 실제 pi에서 fs.watch 콜백의 전달이 한가한 세션에서 턴을 시작하는지는 todo 14에서 확인한다(하네스 자체 inbox 깨움은 win32에서 unsupported_platform - rpc.md 'Interactive sessions expose a control endpoint' 절 - 이므로 자체 fs.watch가 필요하다). 한가한 소유 대화를 다른 창의 `/decide`만으로 깨우는 것이 IS-2의 합격 조건이다(todo 14 (c) 두 프로세스 시험). 전달 예외·held_draft에서 다음 깨움에 재시도하는 것은 안전장치일 뿐 합격 조건을 대신하지 않는다.
  Closes: GAP-2
  Parallelization: Wave 3 | Blocked by: 9,10 | Blocks: 14
  References (executor has NO interview context - be exhaustive): `SENPI/extensions/types.d.ts` 657·1847·1891줄(sendUserMessage 설명); `DOCS/extensions.md` 'agent_settled'(745-750, settled 핸들러에서 요청한 실행은 모든 핸들러 뒤 시작), 'ctx.isIdle()'(1307).
  Acceptance criteria (agent-executable): `node --test test/deliver.test.mjs`(가짜 pi, 임시 STATE) 통과: 가짜 pi.session에서 자기 결정 답 -> admitExternalMessage 1회(delivery_id·문구 정확 일치), 반환 직후 receipt 없음, 가짜 listAdmittedDeliveries의 emitted에 id가 나타난 다음 이벤트에서 receipt(proven:true) 1개; 가짜 message_end에 전달 메시지(role custom, 같은 delivery_id)가 지나가도 emitted·저장된 브랜치 엔트리가 없으면 receipt 0개, 이어서 failed에 나타나면(저장 실패) receipt 0개 유지 + settled 뒤 재 admit, 재 admit 뒤 emitted에 나타난 다음 이벤트에서야 receipt 1개; pi.session 경로에서 proven:false receipt 0개; 같은 답을 두 번 훑아도 두 번째는 already_admitted로 처리되고 receipt 1개; held_draft -> receipt 없음, 다음 input에서 성공; 다른 세션 결정 -> 0회; 예외 -> receipt 없음·lastError 기록·다음 깨움에서 성공; session_start 시 밀린 답 -> on-resume; pi.session이 없는 가짜 pi -> 한가할 때 sendUserMessage 1회 + `proven:false`, 작업 중이면 settled 뒤; pi.session이 있는 가짜 pi에서 작업 중(isIdle=false) 답 -> agent_settled 전 admitExternalMessage 0회, agent_settled 핸들러에서 1회(kind started) + emitted 확인 뒤 receipt mode after-turn.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/deliver.test.mjs` 출력 EV/task-11-deliver.txt. failure - 같은 출력의 '전송 예외 후 재시도' 케이스.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(deliver): cross-session decision delivery with exclusive claim and receipts

- [x] 12. 질문 알림 미러 만들기: 열린 질문 표시·시간 초과는 결정 카드로 (src/mirror.mjs)
  Recommended task executor category: deep-low - 설치된 원본의 이벤트 전달 방식을 읽어 연결하고 없을 때의 동작을 정해야 한다.
  What to do / Must NOT do: 공개 경로는 `pi.events.on('ask-user:asked' | 'ask-user:closed')`다(DOCS extensions.md 'Pending-question bus events'). payload 형태(asked: `{ctx, request, variant}`, closed: `{requestId, status, resolvedBy?}`)를 그 절과 `SENPI/extensions/builtin/ask-user/notify.js`·`tool.js`에서 확인해 fixture로 옮긴다. `pi.events`가 있으면 Scope '질문 알림 미러' 그대로 구현(선택지 앞 3개를 A/B/C로, 라벨에 '추천'/'Recommended'가 있는 것을 recommend, 없으면 A, reason '질문 알림 시간 초과로 옮김'). 없거나 비공개 내부만 있으면 내부 모듈을 import하지 말고 meta.mirrorUnavailable=true만 기록해 칩을 띄운다. 사용한 경로와 근거 줄을 `REPO/docs/mirror-source.md`에 적는다.
  Closes: GAP-2, GAP-6
  Parallelization: Wave 3 | Blocked by: 10 | Blocks: 14
  References (executor has NO interview context - be exhaustive): `SENPI/extensions/builtin/ask-user/notify.js:2-3`, `tool.js`(268행 설명: 기본 30분 유휴 시간 초과), `pending.js`, `SENPI/extensions/types.d.ts`.
  Acceptance criteria (agent-executable): `node --test test/mirror.test.mjs` 통과: (구독 가능 시) asked -> mirror 파일, 답하고 closed -> mirror 제거·결정 0건, 답 없이 closed -> source 'question-timeout' 결정 1건(선택지 매핑·recommend 규칙 일치); (불가 시) mirrorUnavailable 칩. 어느 경로인지 docs/mirror-source.md에 기록됨.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/mirror.test.mjs` 출력 EV/task-12-mirror.txt. failure - 이벤트 버스가 없는 가짜 pi에서 예외 없이 칩만 뜨는 케이스(같은 출력).
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(mirror): read-only question mirror and timeout-to-decision conversion

- [x] 13. 설치기 만들기: 세대 폴더·관리 shim·초기 빈 페이지·제거 (scripts/install.mjs)
  Recommended task executor category: quick - 파일 복사와 가드 규칙이다.
  What to do / Must NOT do: Scope '설치·끄기' 그대로 + 설치 끝에 `<dir>/briefing/state/`에 빈 저장소로 렌더해 '아직 보고 없음 - 새로 연 OMO 대화부터 표시됨' 페이지를 만든다(이미 상태가 있으면 기존 상태로 렌더). `--dry-run`은 무엇을 쓸지 목록만 출력. 빌드되지 않은 dist면 중단. 브라우저를 열지 않는다.
  Closes: GAP-7
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 15
  References (executor has NO interview context - be exhaustive): 관리 shim 선례 `AGENT/extensions/omo-herdr-dashboard.js`(내용 2줄: 관리 주석 + re-export); 세대 폴더 선례 `AGENT/herdr-dashboard/integration/generation-000007/`.
  Acceptance criteria (agent-executable): `node --test test/install.test.mjs`(임시 agent dir) 통과: 첫 설치 -> generation-000001 + shim 내용 정확 일치 + current.json + state/index.html; 두 번째 설치 -> generation-000002, generation-000001 해시 불변; 비관리 omo-briefing.js 있으면 exit 1·쓴 파일 0; --dry-run 쓴 파일 0; --uninstall은 shim만 삭제; extensions/의 다른 파일 해시 전후 동일.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/install.test.mjs` 출력 EV/task-13-install.txt. failure - 같은 출력의 '비관리 shim 거절' 케이스.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(install): generation install, managed shim, initial page and uninstall

- [~] 14. 격리된 실제 pi에서 통합 시험하기 (RPC)
  Recommended task executor category: deep-low - 실제 하네스에서 이벤트를 구독하며 전달 경로를 입증한다.
  What to do / Must NOT do: `npm run build` 후 `REPO/test/integration/rpc-run.mjs`(npm test에 포함하지 않음)를 만들어 Verification strategy의 격리 방식으로 pi RPC를 띄운다. 명령·이벤트 형식은 `DOCS/rpc.md`를 따른다. 순서: (a) 도구·명령 목록에 brief·decide가 있음을 확인(모델 호출 없음) (b) 결정적 시험을 위해 `test/integration/scripted-provider.mjs` 확장을 함께 `-e`로 실어 `pi.registerProvider`(DOCS extensions.md 'pi.registerProvider', 작성 시 2388행)로 미리 정한 응답(brief 도구 호출 1회 -> '끝')을 돌려주는 시험용 모델을 등록하고 `--model`로 선택한다(맞지 않으면 현재 기본 모델 사용, 사유를 summary에). 프롬프트 1: '다음 JSON으로 brief 도구를 한 번만 호출하고 끝이라고만 답해: ...'(결정 2개 포함) -> agent_settled까지 기다려 briefs/000001.json·decisions 2개·index.html 확인 + 마지막 답 줄 수 기록(관찰값, 합격 기준 아님) (c) **두 프로세스 시험(필수)**: 같은 임시 STATE와 같은 시험용 모델을 쓰는 두 번째 RPC 프로세스 B(다른 세션)를 띄우고, (b)의 프로세스 A가 한가한 상태에서 B로만 `/decide <첫 번호>A`를 보낸다. A의 RPC 이벤트에서 agent_start와, 그 실행 안에서 role `custom`·customType `session_control_delivery`·details.delivery_id `d<번호>`인 메시지(내용 '[결정 전달] #N -> A')의 message_end를 모두 관찰하면 abort(user 메시지를 기다리지 않음), receipt 존재 + `proven:true` + A 세션 파일에 같은 delivery_id의 `custom_message` 엔트리(customType `session_control_delivery`) 확인, 같은 `/decide`를 다시 보내도 전달이 늘지 않음(이미 답함 오류). A가 B의 `/decide`만으로(A에 추가 입력 없이) 20초 안에 깨어나지 않으면 todo 14는 실패다: 원인을 조사해 고치고, 공개 API로 불가능하다는 근거가 나오면 중단하고 'IS-2 미충족'으로 소유자에게 보고한다(다음 입력 때 전달되는 대체 동작은 IS-2 합격으로 치지 않음) (d) 프롬프트 3('1부터 3까지 한 줄씩 세고 끝') 진행 중 두 번째 결정 답을 저장소 API로 직접 기록 -> 그 실행의 agent_settled 이벤트까지 A 세션의 customType session_control_delivery인 custom 메시지 0건, 그 직후 새 agent_start와 함께 1건(receipt mode after-turn) 확인 후 abort (e) `/decide 99A` -> 오류 문구·answers 변화 없음(모델 호출 없음) (f) README에서 세션 디렉터리 지정 플래그를 찾아 `senpi-task/children` 경로로 두 번째 RPC를 띄워 brief가 등록되지 않음을 확인(플래그가 없으면 이 항목은 todo 10 단위 테스트로 대신한다고 증거에 명시). 실제 구독 모델 프롬프트는 총 4회 이하(시험용 모델을 쓰면 (b)(c)(d)는 0회이고, IS-4 실측(필수): 실제 구독 모델로 '간단한 질문 1개에 답하고 brief를 호출해' 프롬프트 3회를 보내(확장이 요청한 이어쓰기 턴은 횟수에 넣지 않음) 각 실행의 채팅 맨 끝 답(마지막 assistant 답, 확장이 omo-briefing-reply custom_message를 덧붙였으면 그 메시지)이 빈 줄 제외 10줄·700자 이내이고 상황판 절대경로를 포함하는지 세션 파일에서 기계로 센다. 3회 모두 만족해야 합격이고, 실행마다 모델이 스스로 지켰는지·이어쓰기로 지켰는지·자동 줄임이나 덧붙임으로 지켰는지 기록한다. 실패는 강제 경로의 결함이므로 고쳐 남은 1회로 재시험하고, 그래도 실패하면 todo 14 실패로 소유자에게 보고한다(예산 숫자를 늘리지 않음)). API 키·인증 파일을 임시 폴더로 복사하지 않는다. 실사용 STATE·실사용 extensions 폴더·열린 세션 무접촉. 끝나면 띄운 pi 프로세스를 자기 PID로만 종료한다.
  Closes: GAP-2, GAP-4, GAP-5
  Parallelization: Wave 4 | Blocked by: 10,11,12 | Blocks: 15
  References (executor has NO interview context - be exhaustive): `DOCS/rpc.md`; `AGENT/runtime/<id>/README.md` 650-660행(`-e, --extension`, `--no-extensions`); pi 실행 파일 `C:/Users/USER/.bun/install/global/node_modules/.bin/pi.exe`; 이번 플랜 Verification strategy.
  Acceptance criteria (agent-executable): EV/task-14-events.jsonl(모든 RPC 이벤트), EV/task-14-state-tree.txt(임시 STATE 파일 목록·receipt 내용), EV/task-14-summary.json `{toolListed, briefStored, decisionsCreated:2, idleDelivery:true, crossProcess:true, afterTurnDelivered, unknownDecideRejected, childGate:'rpc'|'unit-only', prompts<=4, lastReplyLines:[숫자 3개], replyPath:['model'|'rewrite'|'trimmed'|'appended' 3개], replyBudgetPass:true}`; (b)(c)(d)(e)가 모두 참이고, (c)는 B의 `/decide`만으로 A가 깨어나 A 세션 파일에 customType `session_control_delivery`·details.delivery_id `d<번호>`인 `custom_message` 엔트리가 남은 경우에만 참.
  QA scenarios (name the exact tool + invocation): happy - `node REPO/test/integration/rpc-run.mjs --state <tmp> --out EV` 실행과 결과 페이지 캐처 EV/task-14-page.png(브라우저 스킬). failure - (e) 단계 출력과 answers 폴더 전후 목록 동일 증거(같은 events.jsonl).
  Commit: N (소유자 별도 승인 시 쓸 메시지) | test(integration): isolated rpc run for brief, decide and delivery

- [x] 15. 실사용 piomo에 설치하고 새 프로세스 로드 확인하기
  Recommended task executor category: unspecified-low - 정해진 설치기를 가드와 함께 실행하고 증거를 남긴다.
  What to do / Must NOT do: 사전: `npm run check` 통과, `REPO`의 extension.mjs·src/·scripts/·dist/ 모든 파일 sha256을 EV/task-15-source.json에 기록(커밋이 없으므로 git 상태 대신 이 해시 목록이 설치 원본의 기준), todo 14 summary 존재. `AGENT/extensions/` 전 파일과 `AGENT/settings.json`의 sha256을 EV/task-15-before.json에 기록. `omo-briefing.js`가 있고 관리 파일이 아니면 중단·보고. `node REPO/scripts/install.mjs --agent-dir AGENT --dry-run` 출력 기록 후 실제 설치. 사후: 기존 파일 해시 전부 동일, 새 파일은 omo-briefing.js 1개뿐, 세대 폴더 해시 = dist, `AGENT/briefing/state/index.html` 존재. 로드 확인: 임시 cwd에서 HERDR_* 환경변수를 지우고 `OMO_BRIEFING_STATE_DIR=<임시>`로 `pi --mode rpc`를 `-e` 없이 띄워(실사용 프로필 자동 발견) brief 도구·decide 명령 등록을 확인하고 프롬프트 없이 종료(모델 호출 0). 소유자의 열린 세션 재시작·reload 금지, 브라우저 자동 열기 금지.
  Closes: GAP-7
  Parallelization: Wave 4 | Blocked by: 13,14 | Blocks: F1-F4
  References (executor has NO interview context - be exhaustive): 설치기(todo 13); `DOCS/rpc.md`; 기존 확장 목록(작성 시 diff.js, files.js, goal, omo-herdr-dashboard.js, prompt-url-widget.js, tps.js).
  Acceptance criteria (agent-executable): EV/task-15-before.json·task-15-after.json 비교에서 기존 항목 변화 0·추가 1(omo-briefing.js); shim 내용 = 설치기 기대값; EV/task-15-load.txt에 brief·decide 등록 확인 줄; 끝난 뒤 띄운 프로세스 없음.
  QA scenarios (name the exact tool + invocation): happy - 위 절차를 PowerShell과 `node`로 실행한 로그 EV/task-15-install.txt. failure - 설치 전 `--dry-run`이 아무것도 쓰지 않았다는 해시 비교(EV/task-15-dryrun.json).
  Commit: N | 실사용 프로필은 git 저장소가 아니며 REPO 변경 없음

- [x] 16. 짧은 한글 사용 안내서 쓰기 (README.ko.md)
  Recommended task executor category: writing - 사용자 문서다.
  What to do / Must NOT do: `REPO/README.ko.md` 80줄 이하, 카드형 소제목 6개: 열기(`/brief`, 페이지 절대경로), 보는 법(탭 3개·칩 뜻 표), 답하는 법(`/decide 12A 13B`, 번호만 = 추천안, 전달 영수증 뜻), 일시 끄기(`/brief off`/`on`), 완전 제거(`node <REPO>/scripts/install.mjs --agent-dir <AGENT> --uninstall` 또는 shim 파일 삭제), 알아둘 것(열려 있던 대화는 새로 열어야 적용, 결정 기록은 설치·푸시 승인이 아님, 보고 없음 칩의 뜻). 설치기가 같은 파일을 `AGENT/briefing/README.ko.md`로 복사하도록 todo 13 설치 목록에 더한다(테스트 기대값도 갱신). 전문용어는 처음 나올 때 한 마디로 푼다.
  Closes: GAP-7
  Parallelization: Wave 4 | Blocked by: 10 | Blocks: F1-F4
  References (executor has NO interview context - be exhaustive): 명령 목록은 extension.mjs 등록 코드(todo 10); 소유자 보고 형식 선호 `.../system/human.md` 'PREFERENCE (보고 형식, 2026-10-10)'.
  Acceptance criteria (agent-executable): `node --test test/readme.test.mjs`: 줄 수 <= 80, 문서에 나오는 모든 `/` 명령이 extension.mjs에 등록된 이름과 일치, `--uninstall` 문구 존재, install 테스트가 README 복사를 확인.
  QA scenarios (name the exact tool + invocation): happy - `node --test test/readme.test.mjs test/install.test.mjs` 출력 EV/task-16-readme.txt. failure - README에 없는 명령 `/brief-x`를 임시로 넣은 복사본에서 테스트가 실패하는지 확인(같은 테스트 파일 안의 음성 케이스).
  Commit: N (소유자 별도 승인 시 쓸 메시지) | docs: short Korean usage guide

- [x] 17. 설치기가 기존 상황판을 렌더러로 다시 그리기 (scripts/install.mjs, 후속)
  Recommended task executor category: quick - todo 13 검증에서 나온 후속: 재설치 시 기존 STATE가 있으면 todo 7 렌더러로 다시 게시한다.
  What to do / Must NOT do: todo 13 행의 '(이미 상태가 있으면 기존 상태로 렌더)'를 todo 7의 `renderPage`(render.lock·published.json seq 규칙 그대로)로 구현한다. 기존 seq보다 낮은 seq로 게시하지 않고, 살아 있는 잠금이면 건너뛰고 사유를 출력한다. 실사용 AGENT는 건드리지 않는다(시험은 임시 폴더).
  Closes: GAP-7
  Parallelization: Wave 3 | Blocked by: 7,13 | Blocks: 15
  References (executor has NO interview context - be exhaustive): todo 13 행, Scope '설치·끄기'·'렌더(게시)'; 검증 보고 `C:/Users/USER/orca/projects/기타 작업/.omo/evidence/piomo-living-briefing-task-13-gate-review-a2.md` follow_up.
  Acceptance criteria (agent-executable): `node --test test/install.test.mjs`: seq 42 게시판이 있는 임시 STATE에 재설치 -> 렌더러로 다시 게시되어 seq 43, 기존 대화 카드 유지; 살아 있는 render.lock -> 게시 건너뜀 + 사유 출력 + shim·세대는 설치.
  QA scenarios (name the exact tool + invocation): happy - 위 테스트 출력 EV/task-17-reinstall-render.txt. failure - 같은 출력의 살아 있는 잠금 케이스.
  Commit: N (소유자 별도 승인 시 쓸 메시지) | feat(install): re-render existing board on reinstall

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Recommended task executor category: unspecified-high - 플랜 전체 대조 감사다.
  QA: 이 플랜과 REPO 파일 트리(`git -C REPO status --porcelain --untracked-files=all` 출력)·EV의 todo별 증거 파일·EV/task-15-source.json을 대조해 todo 1~16 수용 기준 충족 여부를 표로. Must NOT have 기계 검사: `rg -n "https?://" REPO/src REPO/extension.mjs`(0건), `rg -n "setInterval" REPO/extension.mjs REPO/src/*.mjs`(0건; page.js는 허용), `rg -n "senpi-task" REPO/src`(collect.mjs의 파일 읽기만), `rg -n "fs.watch" REPO/src`(answers 폴더만), `rg -n "herdr pane" REPO`(0건), `rg -n "검증됨" REPO/src`(0건), EV/task-15 전후 해시 비교. Evidence EV/f1.md.
- [~] F2. Code quality review
  Recommended task executor category: unspecified-high - 코드 품질 검토다.
  QA: `cd REPO; npm run check` exit 0 로그; 경계(도구 입력·파일 읽기·외부 명령)에서만 검사하고 오류를 삼키는 곳이 없는지(빈 catch는 칩·lastError 기록이 있어야 함), 테스트에 고정 sleep이 없는지(`rg -n "setTimeout\(|sleep" REPO/test`를 읽고 판정) 검토. Evidence EV/f2.md.
- [x] F3. Real manual QA
  Recommended task executor category: unspecified-high - 실제 화면과 실제 pi 증거를 다시 확인한다.
  QA: 먼저 todo 14의 임시 STATE에 저장소 API(todo 4의 결정 생성 함수, 모델 호출 없음)로 todo 14 (b) 세션이 소유한 미응답 결정 1개(blocks=true)를 추가하고 렌더한 뒤, 그 페이지를 브라우저 스킬로 열어 1440x900·390x844 캐처, '나를 기다림'에 답 안 한 결정이 있는 대화가 있는지, 복사 버튼 값이 `/decide NA`인지, 페이지를 연 채 저장소에 brief를 하나 더 기록(저장소 API, 모델 호출 없음)하고 렌더했을 때 스크롤 위치가 그대로이고 '새 내용 있음' 배지가 뜨는지, 배지를 누르면 같은 탭에서 새 내용이 보이는지 확인. todo 14의 replyBudgetPass·replyPath를 함께 적는다. 실사용 설치본은 소유자가 새 대화를 열기 전까지 '설치됨, 열린 대화에는 미로드'로 구분 표기. Evidence EV/f3-desktop.png, f3-narrow.png, f3.md.
- [x] F4. Ideal-state fidelity
  Recommended task executor category: unspecified-high - IS 행 1:1 대조다.
  QA: Success criteria 표의 IS-1~IS-8을 하나씩 증거 파일과 대조해 충족/미충족을 적고, 미충족은 새 `- [ ] N.` 행으로 추가한다(메모로 남기지 않음). IS-4는 todo 10의 이어쓰기·자동 줄임·덧붙임 시험(모든 분기에서 채팅 맨 끝 답이 기준 안)과 todo 14 replyBudgetPass(실제 모델 3회)로 판정한다. 대상은 확장이 켜진 리드 대화에서 도구를 쓴 실행이다. Evidence EV/f4.md.

## Commit strategy

- 승인 브리프에서 소유자에게 '커밋·푸시는 별도 승인'이라고 알렸으므로 모든 todo는 Commit N. 실행자는 `REPO`에 `git init`만 하고, F1~F4가 끝난 뒤 최종 보고에서 '로컬 커밋을 만들까요?'를 한 번 묻는다(각 todo의 Commit 줄 메시지를 제안 목록으로). git 설정·사용자 정보는 변경 금지.
- push·원격 저장소 생성·PR은 이 플랜 범위 밖(소유자 별도 승인). 나중에 `grim-susemi/piomo-orchestration`에 올릴지는 소유자가 정한다.
- 실사용 프로필(`AGENT`) 변경은 todo 15의 설치기 실행뿐이며 커밋 대상이 아니다.

## Success criteria
> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 6, 7, 8, 10 | todo 6 보기 예산 테스트 + 캐처, todo 7 탭·변화 구분, F3 첫 화면 확인 | EV/task-6-desktop.png, task-7-render.txt, f3-desktop.png |
| IS-2 | 9, 11, 14 | todo 9 전부 아니면 전무, todo 11 중복 없는 전달, todo 14 (c) 두 프로세스 시험(B의 /decide만으로 한가한 A가 깨어남)·(d)·(e) | EV/task-9-decide.txt, task-11-deliver.txt, task-14-summary.json |
| IS-3 | 2, 3, 6 | todo 2 낮춰 저장, todo 3 증거 사라짐, todo 6 변화·완료 행마다 진실 칩과 적용 칩(후보/실사용 적용/적용 해당 없음) 하나씩, 칩 없는 행 0개, '검증됨' 없음 | EV/task-2-schema.txt, task-3-truth.txt |
| IS-4 | 10, 14 | todo 10 규칙 1회 주입·이어쓰기 1회 요청·자동 줄임(fitReply, message_end 교체, custom_message 덧붙임) 시험, todo 14 실제 모델 3회 replyBudgetPass | EV/task-10-extension.txt, task-14-summary.json |
| IS-5 | 6 | todo 6 화면 캐처·상호작용 기록, F3 | EV/task-6-desktop.png, task-6-narrow.png, task-6-interactions.json |
| IS-6 | 5, 6, 7, 10 | todo 5 실측(기본안 또는 iframe 대체안, 둘 다 실패면 미충족), todo 7 동시 게시(seq 중복 없음·최신 데이터 유지), F3 배지·스크롤 유지, todo 10 noReport | EV/task-5-refresh.json, f3.md |
| IS-7 | 7, 8, 12 | todo 7 다중 대화 fixture, todo 8 수집, todo 12 미러 | EV/task-7-render.txt, task-8-collect.txt, task-12-mirror.txt |
| IS-8 | 13, 15, F1 | todo 13 설치·제거 테스트, todo 15 전후 해시, F1 금지 항목 검사 | EV/task-13-install.txt, task-15-before.json, task-15-after.json, f1.md |
