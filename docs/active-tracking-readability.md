# W2 활성 추적 가독성 게이트

이 문서는 브리핑 W2만 다룬다. W1의 설치와 승인은 별도이며 W2 합격이 W1 승인을 대신하지 않는다. 소유자의 W2 명시적 승인 전에는 실사용 설치하지 않는다.

## 화면 계약과 증거

`#main`이 유일한 세로 스크롤 뷰포트다. 내부 섹션은 중첩 카드의 배경·테두리·그림자 없이 평면으로 구분한다. 활성 섹션은 펼치고, 명시적으로 펼친 섹션과 입력 중인 폼·포커스는 갱신으로 닫지 않는다. 초기 진입과 명시적 복귀에서 활성 제목이 상위 8개 안에 보여야 한다.

프로필·에이전트 화면의 역할 목록은 폭과 관계없이 항상 한 칸(역할 하나에 한 행)이고, 좋은 칸에서는 한 행이 두 줄로 접힌다. 카드·구역·행의 구분선과 열린 편집 칸(카드 글 편집, 새 프로필)도 위쪽 실선과 옟은 배경만 쓰는 평면 계약을 그대로 따른다.

F5는 두 크기 1180x700, 1440x900에서 프로필 role/card:experimental-custom과 전체 지정 흐름의 작업당 스크롤 수 S가 1 이하여야 한다. 버튼 중심 hit-test와 가림 0도 필요하다.

- 이전 측정 및 화면: `C:/Users/USER/orca/projects/기타 작업/.omo/evidence/herdr-dag-active-tracking/r1/W2/task-5/flow-map-probe/`의 `screen-1180x700.png`, `screen-1440x900.png`, flow-map JSON. 이전 화면은 전체 후보 화면 목록이 아닌 기준 화면이다.
- 이후: `C:/Users/USER/orca/projects/기타 작업/.omo/evidence/herdr-dag-active-tracking/r1/W2/task-7/captures/index.json` 및 같은 폴더의 화면별 PNG·geometry JSON. 같은 빌드 provenance는 task-7 `build.json`, 크기별 F5 결과는 `flow-diff-1180x700.json`, `flow-diff-1440x900.json`에 있다.

## W2 설치 게이트

1. 현재 설치의 payload 전체와 파일별 해시, HEAD와 미커밋 diff, 현재 generation·seq를 보존한다. 저장되지 않은 입력을 확인하고 실사용 대화를 임의로 종료하지 않는다.
2. `npm test`, `npm run build`, 격리 복구 시험과 화면·F5 증거를 확인한다. 실패나 불일치가 있으면 설치를 중단한다.
3. 실사용 경로에 대한 `node scripts/install.mjs --agent-dir <agent-dir> --dry-run` 결과, 후보 해시, 전후 화면과 복귀 대상을 W2 승인 카드에 제시한다. 미응답은 미설치다.
4. W2 설치 승인 후 정식 installer를 사용한다. 열려 있던 대화는 이전 generation을 계속 쓸 수 있다. 조정된 재시작 후 shim·current.json·서버·페이지 generation, seq, 답변·결정·입력을 확인한다.

## 복귀

1. W2 복귀에 대해 별도 승인을 받는다. live lock을 강제로 삭제하거나 다른 프로세스를 중단하지 않는다.
2. 보존한 이전 payload와 해시를 격리 recovery checkout의 `dist/`에 준비하고 해당 checkout의 정식 installer를 사용한다. 이전 HEAD만으로 당시 dirty payload를 재현했다고 가정하지 않는다.
3. 현재보다 높은 새 generation으로 재설치한다. 과거 generation으로 shim/current.json을 직접 되돌리거나 현재 state를 과거 백업으로 덮어쓰지 않는다.
4. 파일별 payload 해시를 이전 payload와 비교하고, shim/current.json과 새 서버·페이지 generation이 일치하며 seq가 감소하지 않는지 확인한다. 답변·결정 및 열린 탭의 미저장 입력을 확인한다.
5. 열린 대화의 generation은 자동으로 바뀐다고 가정하지 않는다. 소유자와 조정한 재시작 후 다시 확인한다.

## 계획 문구와의 차이

계획의 “live lock을 거절·보존”은 설치 전체의 거절이 아니다. 기존 installer 계약과 `test/install.test.mjs`에 따라 살아 있는 `render.lock`에서는 새 generation과 shim/current.json을 설치하고 페이지 발행만 건너뛰며 종료 코드 0이다. 기존 페이지와 lock은 보존된다. 따라서 복귀 중에도 잠금 충돌 시 페이지가 새 generation으로 발행됐다고 판단하면 안 되며, 잠금 소유자가 정상 종료한 뒤 발행과 generation 일치를 재확인한다.

계획의 “낮은 세대 repoint 거절”도 installer가 임의의 직접 파일 쓰기를 차단한다는 뜻으로 검증할 수 없다. installer에는 repoint 명령이 없고 파일을 직접 덮어쓰면 낮은 번호를 기록할 수 있다. 이것은 제품의 안전장치가 아니라 금지된 수동 조작이다. 복귀는 반드시 더 높은 새 generation 재설치로 수행한다.
