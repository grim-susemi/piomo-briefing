# 로드맵 설치와 복구 게이트

## 이전 세대 데이터의 한계

실제 28세대 발행자는 새 페이지를 유지하면서 `data.js`를 로드맵 필드가 없는
구형 형식으로 다시 게시할 수 있다. 이때 후보 페이지는 구세대 데이터임을
명시하며 착수 가능한 단계로 오인하지 않는다. 이는 승인된 계획의 degraded
경로다. 정의·상태·결정·기록 파일을 삭제하는 복구 방식은 허용하지 않는다.
수용 gate의 최종 판정과 실제 설치 여부는 별도 실행 결과를 확인해야 한다.

## 설치 전 확인

- 실제 agentDir의 현재 세대, shim, 서버와 페이지 세대, 게시 seq, 설정 및 상태
  경로를 읽기 전용으로 기록한다.
- 정상 28세대 payload는 아래 경로에 보존했다. 모든 파일을 동봉 manifest의
  SHA-256 및 파일 목록과 대조한다. 일치하지 않거나 파일이 빠지면 중단한다.
- 고정된 후보 소스와 빌드 payload 해시, 전체 수용 결과, 격리 재설치 결과를
  확인한다. 외부에서 받은 PASS만으로 대신하지 않는다.
- 비관리 shim은 덮어쓰지 않는다. 활성 render.lock으로 페이지 게시를 건너뛰면
  설치 완료로 오인하지 말고 불일치를 해결할 때까지 중단한다.

## 복구 원칙

실제 복구는 후보 설치 승인과 별도로 범위가 명시된 소유자 승인이 필요하다.
승인 후에는 보존한 정상 payload의 전체 해시를 다시 검증하고 별도 복구
checkout의 `dist`에 복사한 다음 그 checkout의 공식 `scripts/install.mjs`를
사용한다. 설치 대상은 승인된 agentDir이어야 한다. 복구도 기존 디렉터리로
되돌리는 것이 아니라 **기존 최대값보다 높은 새 세대**로 다시 설치한다.

shim을 이전 세대로 직접 바꾸거나 현재 state를 옛 복사본으로 덮지 않는다.
등록된 roadmaps, 결정, 기록 및 prefs를 보존한다. 설치 후 current와 shim,
서버와 페이지의 세대, 증가한 seq, 등록·결정·기록의 보존을 확인한다.
기존 서버나 열린 대화가 이전 세대로 남을 수 있으므로 이들까지 일치하기
전에는 복구 완료라고 보고하지 않는다.

### 승인 후 실행할 PowerShell 절차

아래 실제 agentDir에 대한 **복구 승인 전에는 실행하지 않는다**. 먼저 기존
프로세스와 서버의 상태를 확인하고 소유자가 복구 범위를 명시해야 한다. 이
절차는 보존 payload만 별도 checkout에 복사하며 현재 state는 복사하지 않는다.
기존 복구 checkout이 있으면 덮어쓰지 않고 중단한다.

```powershell
$e = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/board-kanban-rail/run-20261105/task-8'
$payload = Join-Path $e 'old-payload'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $e 'old-payload-manifest.json') | ConvertFrom-Json
$checkout = Join-Path $env:TEMP 'omo-briefing-recovery-generation28'
if (Test-Path -LiteralPath $checkout) { throw 'Recovery checkout already exists; stop.' }
$files = @(Get-ChildItem -LiteralPath $payload -File -Recurse)
if ($files.Count -ne @($manifest.sha256.PSObject.Properties).Count) { throw 'Payload file count mismatch.' }
foreach ($item in $manifest.sha256.PSObject.Properties) {
  $file = Join-Path $payload $item.Name
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing payload file: $($item.Name)" }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash -ne $item.Value) { throw "Payload hash mismatch: $($item.Name)" }
}
New-Item -ItemType Directory -Path $checkout | Out-Null
Copy-Item -Recurse -LiteralPath $payload -Destination (Join-Path $checkout 'dist')
Copy-Item -Recurse -LiteralPath (Join-Path $payload 'src') -Destination (Join-Path $checkout 'src')
Copy-Item -Recurse -LiteralPath (Join-Path $payload 'scripts') -Destination (Join-Path $checkout 'scripts')
Copy-Item -Recurse -LiteralPath (Join-Path $payload 'assets') -Destination (Join-Path $checkout 'assets')
foreach ($item in $manifest.sha256.PSObject.Properties) {
  $file = Join-Path (Join-Path $checkout 'dist') $item.Name
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash -ne $item.Value) { throw "Recovery copy mismatch: $($item.Name)" }
  if ($item.Name -match '^(src|scripts|assets)[\\/]') {
    $sourceCopy = Join-Path $checkout $item.Name
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceCopy).Hash -ne $item.Value) { throw "Recovery source mismatch: $($item.Name)" }
  }
}
node (Join-Path $checkout 'scripts/install.mjs') --agent-dir 'C:/Users/USER/.omo-stable-500/home/.omo/agent' --dry-run
if ($LASTEXITCODE -ne 0) { throw 'Dry-run failed; stop.' }
```

dry-run 결과와 승인 범위를 확인한 뒤에만 다음 명령을 실행한다.

```powershell
node (Join-Path $checkout 'scripts/install.mjs') --agent-dir 'C:/Users/USER/.omo-stable-500/home/.omo/agent'
if ($LASTEXITCODE -ne 0) { throw 'Recovery installation failed; inspect before acting.' }
```

게시가 잠금 때문에 건너뛰어진 경우를 포함해 위의 설치 후 일치 검사를 모두
마칠 때까지 완료로 간주하지 않는다. 이 명령은 열린 옛 대화를 재시작하지
않는다. 오래된 프로세스가 다시 데이터를 게시할 가능성도 따로 확인한다.
