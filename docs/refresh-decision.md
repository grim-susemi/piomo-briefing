# file:// 상황판 자동 갱신 방식 결정

선택: 기본안(script 재삽입)

근거: Chrome(소유 브라우저, omowright connectPipe, `file://`)에서 `data.js?v=<n>` script 태그를 1초마다 다시 넣는 방식이 새로고침 없이 seq 2를 약 1초 안에 보았고(로드 표식 동일), scrollY 600이 유지됐다. data.js를 지워도 마지막 내용(seq 2)이 화면에 남고 갱신 시도는 계속됐다. 대체안(iframe + postMessage)도 같은 절차로 통과했으나 기본안이 통과하므로 쓰지 않는다.

측정값(= EV/task-5-refresh.json):

```json
{
  "primaryWorks": true,
  "seqObserved": 2,
  "scrollKept": true,
  "fallbackWorks": true,
  "fallbackScrollKept": true,
  "clipboard": "api",
  "survivesMissingData": true
}
```

증거 경로:
- C:/Users/USER/orca/projects/기타 작업/.omo/evidence/piomo-living-briefing/task-5-refresh.json
- C:/Users/USER/orca/projects/기타 작업/.omo/evidence/piomo-living-briefing/task-5-measure-log.txt
- C:/Users/USER/orca/projects/기타 작업/.omo/evidence/piomo-living-briefing/task-5-before.png
- C:/Users/USER/orca/projects/기타 작업/.omo/evidence/piomo-living-briefing/task-5-after.png
- C:/Users/USER/orca/projects/기타 작업/.omo/evidence/piomo-living-briefing/task-5-missing-data.png

참고:
- 클립보드: `navigator.clipboard.writeText`가 file:// 페이지의 버튼 클릭에서 성공(`api`). 실패 시 `document.execCommand('copy')` 대체 경로는 fixture에 있으나 이번엔 쓰이지 않았다.
- 측정은 보이는(headless 포함) 탭 기준이다. 숨은 탭은 Chrome이 타이머를 늦추므로 `visibilityState === 'visible'`일 때만 갱신한다는 Scope 규칙을 그대로 둔다.
- fixture: test/fixtures/refresh-spike/ (index.html, data.js, index-iframe.html, data.html).
