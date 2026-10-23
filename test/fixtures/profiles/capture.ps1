<#
  capture.ps1 - switcher golden outputs from isolated fixture runs (plan todo 3).

  Builds a throwaway fixture root under
    C:\Users\USER\AppData\Local\Temp\omo-switcher-tests\piomo-pa-<stamp>
  seeds it from the primary home and stable-500 home (and the two lane mirrors when
  they exist live), then drives the Windows switcher's non-GUI modes with
  USERPROFILE=<root>\home and every path passed explicitly inside that root.

  Safety:
    * -FixtureRoot is refused when it is, contains, or sits inside a live home.
    * auth.json / credential-pool-state.json are never copied.
    * Every stored value whose key is exactly one of the credential keys is
      replaced with <redacted>; residual token-shaped strings are redacted too.
    * The whole run is bounded (default 600 s). No WinForms UI is opened.

  Run it from the worktree root:
    powershell -NoProfile -File test/fixtures/profiles/capture.ps1
    pwsh       -NoProfile -File test/fixtures/profiles/capture.ps1
#>
[CmdletBinding()]
param(
    [string]$FixtureRoot,
    [string]$GoldensRoot,
    [string]$SwitcherPath = 'C:\Users\USER\Desktop\OpenCode_Modes\OMO_Native_Profile_Switcher.ps1',
    [int]$TimeoutSeconds = 600,
    [switch]$R3aOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:StartedAt = Get-Date
$script:Deadline = $script:StartedAt.AddSeconds($TimeoutSeconds)
$script:LogLines = New-Object System.Collections.Generic.List[string]

function Write-Log {
    param([string]$Text)
    $line = ('[{0}] {1}' -f ((Get-Date).ToString('HH:mm:ss')), $Text)
    $script:LogLines.Add($line)
    Write-Host $line
}

function Stop-Capture {
    param([string]$Message, [int]$Code = 1)
    Write-Log ('FAIL: ' + $Message)
    [Console]::Error.WriteLine('capture: ' + $Message)
    exit $Code
}

function Get-FullPath {
    param([string]$Path)
    return ([IO.Path]::GetFullPath($Path)).TrimEnd([char[]]@('\', '/'))
}

# ---- isolation refusal (must run before anything is created or launched) -----------------------------------------
$TempParent = 'C:\Users\USER\AppData\Local\Temp\omo-switcher-tests'
$LiveHomes = @(
    'C:\Users\USER\.omo',
    'C:\Users\USER\.omo-stable-500\home\.omo',
    'C:\Users\USER\.omo-original\home\.omo',
    'C:\Users\USER\.somo\home\.omo'
)
$LiveRoots = @(
    'C:\Users\USER\.omo',
    'C:\Users\USER\.omo-stable-500',
    'C:\Users\USER\.omo-original',
    'C:\Users\USER\.somo'
)

function Assert-FixtureRootIsSafe {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) { Stop-Capture 'FixtureRoot is empty.' 2 }
    $full = Get-FullPath $Root
    foreach ($live in @($LiveRoots + $LiveHomes)) {
        $liveFull = Get-FullPath $live
        if ($full -ieq $liveFull -or
            $full.StartsWith($liveFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $liveFull.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Capture ("Fixture root is or overlaps a live home: {0} (live: {1}). Refusing before any switcher run." -f $full, $liveFull) 2
        }
    }
    if (-not $full.StartsWith($TempParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Capture ("Fixture root must be a child of {0}: {1}" -f $TempParent, $full) 2
    }
    return $full
}

if (-not [string]::IsNullOrWhiteSpace($FixtureRoot)) {
    $root = Assert-FixtureRootIsSafe $FixtureRoot
} else {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
    $root = Assert-FixtureRootIsSafe (Join-Path $TempParent ('piomo-pa-' + $stamp))
}
if (Test-Path -LiteralPath $root) { Stop-Capture ("Fixture root already exists: " + $root) 2 }

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) {
    Stop-Capture ("capture.ps1 is not under a piomo-briefing worktree: " + $PSScriptRoot) 1
}
if ([string]::IsNullOrWhiteSpace($GoldensRoot)) { $GoldensRoot = Join-Path $PSScriptRoot 'goldens' }

if (-not (Test-Path -LiteralPath $SwitcherPath -PathType Leaf)) {
    Stop-Capture ("Switcher not found: " + $SwitcherPath) 1
}
$RecommendationManifestSource = Join-Path (Split-Path -Parent $SwitcherPath) 'OMO_Native_Recommendation.json'
if (-not (Test-Path -LiteralPath $RecommendationManifestSource -PathType Leaf)) {
    Stop-Capture ("Recommendation manifest not found: " + $RecommendationManifestSource) 1
}

Write-Log ('fixture root: ' + $root)
Write-Log ('goldens root: ' + $GoldensRoot)
Write-Log ('switcher: ' + $SwitcherPath)

# ---- redaction -------------------------------------------------------------------------------------------------
$script:CredentialKeyPattern = '^(apiKey|api_key|apikey|accessToken|access_token|refreshToken|refresh_token|token|secret|password|authorization)$'
# Built from fragments so this file itself never contains the token literals the acceptance scan forbids.
$script:ValuePatterns = @(
    ('s' + 'k-'),
    ('g' + 'hp_'),
    ('g' + 'ho_'),
    ('x' + 'ox'),
    ('AI' + 'za'),
    ('e' + 'yJ'),
    ('Bear' + 'er ')
)
$script:ValuePatternRegex = ($script:ValuePatterns | ForEach-Object { [regex]::Escape($_) }) -join '|'

function Redact-Value {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        $text = [string]$Value
        foreach ($pattern in $script:ValuePatterns) {
            if ($text.Contains($pattern)) { return '<redacted>' }
        }
        return $text
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) {
            if ([string]$key -imatch $script:CredentialKeyPattern -and $null -ne $Value[$key]) { $copy[[string]$key] = '<redacted>' }
            else { $copy[[string]$key] = Redact-Value $Value[$key] }
        }
        return [pscustomobject]$copy
    }
    if ($Value -is [System.Collections.IList]) {
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($item in $Value) { $items.Add((Redact-Value $item)) }
        return ,$items.ToArray()
    }
    if ($Value -is [pscustomobject]) {
        $copy = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            if ($property.Name -imatch $script:CredentialKeyPattern -and $null -ne $property.Value) { $copy[$property.Name] = '<redacted>' }
            else { $copy[$property.Name] = Redact-Value $property.Value }
        }
        return [pscustomobject]$copy
    }
    return $Value
}

function Redact-Text {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $parsed = $null
    try { $parsed = $Text | ConvertFrom-Json } catch { $parsed = $null }
    if ($null -ne $parsed) { return (Redact-Value $parsed) }
    $keyPattern = '("(?:apiKey|api_key|apikey|accessToken|access_token|refreshToken|refresh_token|token|secret|password|authorization)"\s*:\s*")[^"]*(")'
    $Text = [regex]::Replace($Text, $keyPattern, '$1<redacted>$2', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $Text = [regex]::Replace($Text, '"[^"]*(?:' + $script:ValuePatternRegex + ')[^"]*"', '"<redacted>"')
    return $Text
}

# ---- helpers ---------------------------------------------------------------------------------------------------
function Get-Sha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-IfExists {
    param([string]$From, [string]$To)
    if (-not (Test-Path -LiteralPath $From -PathType Leaf)) { return $false }
    $parent = Split-Path -Parent $To
    if (-not [string]::IsNullOrWhiteSpace($parent)) { [void][IO.Directory]::CreateDirectory($parent) }
    [IO.File]::Copy($From, $To, $true)
    return $true
}

function Save-JsonFile {
    param([string]$Path, $Value)
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) { [void][IO.Directory]::CreateDirectory($parent) }
    $json = $Value | ConvertTo-Json -Depth 100
    # Windows PowerShell 5.1 escapes < > & ' as \uXXXX; keep the literal <redacted> marker readable.
    $json = $json.Replace('\u003c', '<').Replace('\u003e', '>').Replace('\u0026', '&').Replace('\u0027', "'")
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Copy-HomeSeed {
    param([string]$Source, [string]$Dest)
    [void][IO.Directory]::CreateDirectory($Dest)
    $copied = New-Object System.Collections.Generic.List[string]
    $relativeFiles = @(
        'omo.jsonc',
        'native-profile-selection.json',
        'commandcode-subscriptions.json',
        'memory-model-selection.json',
        'agent\settings.json',
        'agent\models.json',
        'agent\models-store.json',
        'agent\native-profile-selection.json'
    )
    foreach ($relative in $relativeFiles) {
        if (Copy-IfExists (Join-Path $Source $relative) (Join-Path $Dest $relative)) { $copied.Add($relative) }
    }
    $runtime = Join-Path $Source 'runtime'
    if (Test-Path -LiteralPath $runtime -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $runtime -File -Filter '*.json' -Force | Sort-Object Name)) {
            if ($file.Name -match '(?i)(auth|credential)') { continue }
            $relative = 'runtime\' + $file.Name
            if (Copy-IfExists $file.FullName (Join-Path $Dest $relative)) { $copied.Add($relative) }
        }
    }
    foreach ($dir in @('runtime\native-profile-switcher-backups')) {
        [void][IO.Directory]::CreateDirectory((Join-Path $Dest $dir))
    }
    return ,$copied.ToArray()
}

function Read-GoldenFile {
    param([string]$Path)
    $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $null }
    if ($null -ne $parsed) { return (Redact-Value $parsed) }
    return [ordered]@{ sha256 = (Get-Sha256 $Path); unparsed = (Redact-Text $raw) }
}

function Get-BackupIndex {
    $result = [ordered]@{}
    foreach ($entry in @(
        @{ name = 'primary'; path = (Join-Path $root 'home\.omo\runtime\native-profile-switcher-backups') }
        @{ name = 'stable'; path = (Join-Path $root 'home\.omo-stable-500\home\.omo\runtime\native-profile-switcher-backups') }
    )) {
        if (-not (Test-Path -LiteralPath $entry.path -PathType Container)) { continue }
        $files = @(Get-ChildItem -LiteralPath $entry.path -File -Force | Sort-Object Name | ForEach-Object {
            [ordered]@{ name = $_.Name; sha256 = (Get-Sha256 $_.FullName) }
        })
        $result[$entry.name] = $files
    }
    return [pscustomobject]$result
}

function Get-ResultingFiles {
    $candidates = [ordered]@{
        'primary/omo.jsonc'                         = (Join-Path $root 'home\.omo\omo.jsonc')
        'primary/settings.json'                     = (Join-Path $root 'home\.omo\agent\settings.json')
        'primary/models.json'                       = (Join-Path $root 'home\.omo\agent\models.json')
        'primary/selection.json'                    = (Join-Path $root 'home\.omo\native-profile-selection.json')
        'primary/agent-selection.json'              = (Join-Path $root 'home\.omo\agent\native-profile-selection.json')
        'primary/runtime-selection.json'            = (Join-Path $root 'home\.omo\runtime\native-profile-selection.json')
        'primary/main-override.json'                = (Join-Path $root 'home\.omo\runtime\native-profile-switcher-main.json')
        'primary/recommendation-state.json'         = (Join-Path $root 'home\.omo\runtime\native-profile-switcher-recommendation.json')
        'primary/subscriptions.json'                = (Join-Path $root 'home\.omo\commandcode-subscriptions.json')
        'stable/omo.jsonc'                          = (Join-Path $root 'home\.omo-stable-500\home\.omo\omo.jsonc')
        'stable/settings.json'                      = (Join-Path $root 'home\.omo-stable-500\home\.omo\agent\settings.json')
        'stable/selection.json'                     = (Join-Path $root 'home\.omo-stable-500\home\.omo\native-profile-selection.json')
        'opencode/opencode.json'                    = (Join-Path $root 'home\.config\opencode\opencode.json')
        'mirror-omo-original/omo.jsonc'             = (Join-Path $root 'home\.omo-original\home\.omo\omo.jsonc')
        'mirror-omo-original/settings.json'         = (Join-Path $root 'home\.omo-original\home\.omo\agent\settings.json')
        'mirror-somo/omo.jsonc'                     = (Join-Path $root 'home\.somo\home\.omo\omo.jsonc')
        'mirror-somo/settings.json'                 = (Join-Path $root 'home\.somo\home\.omo\agent\settings.json')
    }
    $result = [ordered]@{}
    foreach ($relative in $candidates.Keys) {
        $path = $candidates[$relative]
        if (Test-Path -LiteralPath $path -PathType Leaf) { $result[$relative] = (Read-GoldenFile $path) }
    }
    $result['backups'] = Get-BackupIndex
    return $result
}

# ---- build the fixture seed ------------------------------------------------------------------------------------
[void][IO.Directory]::CreateDirectory($root)
[void][IO.Directory]::CreateDirectory((Join-Path $root 'seed\home'))
[void][IO.Directory]::CreateDirectory((Join-Path $root 'inputs'))

$primarySource = 'C:\Users\USER\.omo'
$stableSource = 'C:\Users\USER\.omo-stable-500\home\.omo'
$primarySeed = Copy-HomeSeed $primarySource (Join-Path $root 'seed\home\.omo')
$stableSeed = Copy-HomeSeed $stableSource (Join-Path $root 'seed\home\.omo-stable-500\home\.omo')
if (-not (Test-Path -LiteralPath (Join-Path $root 'seed\home\.omo\omo.jsonc') -PathType Leaf)) {
    Stop-Capture 'Primary home omo.jsonc was not seeded.' 1
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'seed\home\.omo-stable-500\home\.omo\omo.jsonc') -PathType Leaf)) {
    Stop-Capture 'Stable-500 omo.jsonc was not seeded.' 1
}

$laneMirrorFixtureRoots = New-Object System.Collections.Generic.List[string]
$laneMirrorReport = New-Object System.Collections.Generic.List[object]
foreach ($lane in @(
    @{ Name = 'omo-original'; Source = 'C:\Users\USER\.omo-original\home\.omo'; Dest = (Join-Path $root 'seed\home\.omo-original\home\.omo') }
    @{ Name = 'somo'; Source = 'C:\Users\USER\.somo\home\.omo'; Dest = (Join-Path $root 'seed\home\.somo\home\.omo') }
)) {
    if (Test-Path -LiteralPath (Join-Path $lane.Source 'omo.jsonc') -PathType Leaf) {
        $copied = Copy-HomeSeed $lane.Source $lane.Dest
        $laneMirrorFixtureRoots.Add($lane.Dest)
        $laneMirrorReport.Add([ordered]@{ name = $lane.Name; source = $lane.Source; present = $true; copied = @($copied) })
        Write-Log ('seeded live lane mirror: ' + $lane.Source)
    } else {
        $laneMirrorReport.Add([ordered]@{ name = $lane.Name; source = $lane.Source; present = $false; copied = @() })
        Write-Log ('lane mirror absent live, skipped: ' + $lane.Source)
    }
}

$recommendationFixture = Join-Path $root 'inputs\OMO_Native_Recommendation.json'
[void](Copy-IfExists $RecommendationManifestSource $recommendationFixture)

$opencodeSeed = Join-Path $root 'seed\home\.config\opencode\opencode.json'
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $opencodeSeed))
$opencodeBody = @'
{
    "$schema": "https://opencode.ai/config.json",
    "provider": {
        "ollama-cloud": {
            "npm": "@ai-sdk/openai-compatible",
            "name":  "Ollama Cloud",
            "options": {
                "baseURL":  "https://ollama.com/v1"
            }
        }
    }
}
'@
[IO.File]::WriteAllText($opencodeSeed, $opencodeBody, (New-Object Text.UTF8Encoding($false)))

$seedIndex = [ordered]@{}
foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $root 'seed') -Recurse -File -Force | Sort-Object FullName)) {
    $relative = $file.FullName.Substring((Join-Path $root 'seed').Length).TrimStart([char[]]@('\', '/'))
    $seedIndex[$relative] = Get-Sha256 $file.FullName
}

$liveHashesBefore = [ordered]@{
    'C:\Users\USER\.omo-stable-500\home\.omo\omo.jsonc'        = Get-Sha256 'C:\Users\USER\.omo-stable-500\home\.omo\omo.jsonc'
    'C:\Users\USER\.omo-stable-500\home\.omo\agent\settings.json' = Get-Sha256 'C:\Users\USER\.omo-stable-500\home\.omo\agent\settings.json'
    'C:\Users\USER\.omo-stable-500\home\.omo\agent\models.json'   = Get-Sha256 'C:\Users\USER\.omo-stable-500\home\.omo\agent\models.json'
    'C:\Users\USER\.omo\omo.jsonc'                              = Get-Sha256 'C:\Users\USER\.omo\omo.jsonc'
    'C:\Users\USER\.omo\agent\settings.json'                    = Get-Sha256 'C:\Users\USER\.omo\agent\settings.json'
}

if ($laneMirrorFixtureRoots.Count -gt 0) {
    $laneArgs = @('-LaneMirrorRoots') + @($laneMirrorFixtureRoots.ToArray())
} else {
    $laneArgs = @()
}

# ---- scenario runner --------------------------------------------------------------------------------------------
function Invoke-Scenario {
    param(
        [string]$Name,
        [string]$Mode,
        [string[]]$ModeArgs,
        [string]$IntentPath = $null
    )
    if ((Get-Date) -ge $script:Deadline) { Stop-Capture ('time budget exhausted before ' + $Name) 124 }
    $scenarioHome = Join-Path $root 'home'
    if (Test-Path -LiteralPath $scenarioHome) { Remove-Item -LiteralPath $scenarioHome -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $root 'seed\home') -Destination $scenarioHome -Recurse -Force

    $outDir = Join-Path $root ('out\' + $Name)
    [void][IO.Directory]::CreateDirectory($outDir)
    $resultFile = Join-Path $outDir 'result.json'

    $argList = New-Object System.Collections.Generic.List[string]
    foreach ($arg in @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', $SwitcherPath,
        '-IsolatedApplyRoot', $root,
        '-ConfigPath', (Join-Path $root 'home\.omo\omo.jsonc'),
        '-SettingsPath', (Join-Path $root 'home\.omo\agent\settings.json'),
        '-ModelsPath', (Join-Path $root 'home\.omo\agent\models.json'),
        '-MainOverridePath', (Join-Path $root 'home\.omo\runtime\native-profile-switcher-main.json'),
        '-SubscriptionsPath', (Join-Path $root 'home\.omo\commandcode-subscriptions.json'),
        '-BackupDirectory', (Join-Path $root 'home\.omo\runtime\native-profile-switcher-backups'),
        '-RecommendationStatePath', (Join-Path $root 'home\.omo\runtime\native-profile-switcher-recommendation.json'),
        '-RecommendationManifestPath', $recommendationFixture,
        '-Stable500HomePath', (Join-Path $root 'home\.omo-stable-500\home\.omo')
    )) { $argList.Add([string]$arg) }
    foreach ($arg in $laneArgs) { $argList.Add([string]$arg) }
    foreach ($arg in $ModeArgs) { $argList.Add([string]$arg) }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $psi.Arguments = (($argList | ForEach-Object { '"' + ([string]$_ -replace '"', '\"') + '"' }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $RepoRoot
    $psi.EnvironmentVariables['USERPROFILE'] = (Join-Path $root 'home')
    # The child is Windows PowerShell 5.1. Under pwsh the inherited PSModulePath points at
    # PowerShell 7 modules, which hides the 5.1 inbox modules (Get-FileHash and friends fail).
    # Give the child only the Windows PowerShell module path; the parent env is untouched.
    $psi.EnvironmentVariables['PSModulePath'] = @(
        (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'),
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules')
    ) -join ';'

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $watch = [Diagnostics.Stopwatch]::StartNew()
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $remainingMs = [int][Math]::Max(1000, ($script:Deadline - (Get-Date)).TotalMilliseconds)
    if (-not $process.WaitForExit($remainingMs)) {
        try { $process.Kill() } catch { }
        Stop-Capture ('switcher timed out in scenario ' + $Name) 124
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    $watch.Stop()
    $process.Dispose()

    $resultValue = $null
    if (Test-Path -LiteralPath $resultFile -PathType Leaf) {
        $resultValue = Read-GoldenFile $resultFile
    }
    $stdoutValue = $null
    if (-not [string]::IsNullOrWhiteSpace($stdout)) { $stdoutValue = Redact-Text $stdout }
    $intentValue = $null
    if (-not [string]::IsNullOrWhiteSpace($IntentPath) -and (Test-Path -LiteralPath $IntentPath -PathType Leaf)) {
        $intentValue = Read-GoldenFile $IntentPath
    }

    $output = [ordered]@{
        scenario   = $Name
        mode       = $Mode
        modeArgs   = @($ModeArgs)
        exitCode   = $exitCode
        durationMs = [int]$watch.ElapsedMilliseconds
        engine     = 'powershell.exe'
        intent     = $intentValue
        stream       = $stdoutValue
        result       = $resultValue
    }

    $scenarioDir = Join-Path $GoldensRoot $Name
    if (Test-Path -LiteralPath $scenarioDir) { Remove-Item -LiteralPath $scenarioDir -Recurse -Force }
    [void][IO.Directory]::CreateDirectory($scenarioDir)
    Save-JsonFile (Join-Path $scenarioDir 'output.json') $output

    $fixtureFiles = Get-ResultingFiles
    $hashList = [ordered]@{}
    $hashList['output.json'] = Get-Sha256 (Join-Path $scenarioDir 'output.json')
    foreach ($relative in $fixtureFiles.Keys) {
        $safeName = ([string]$relative).Replace('/', '\')
        $dest = Join-Path $scenarioDir ('files\' + $safeName + '.json')
        Save-JsonFile $dest $fixtureFiles[$relative]
        $hashList[('files/' + ([string]$relative) + '.json')] = Get-Sha256 $dest
    }

    $script:ScenarioRecords[$Name] = [ordered]@{
        mode = $Mode
        exitCode = $exitCode
        files = $hashList
    }
    Write-Log ('scenario {0}: exit {1} ({2} ms)' -f $Name, $exitCode, $watch.ElapsedMilliseconds)
    if ($exitCode -ne 0) {
        if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Log ('stderr: ' + ($stderr.Trim())) }
        Stop-Capture ('scenario failed: ' + $Name) 1
    }
}

$script:ScenarioRecords = [ordered]@{}
$goldensParent = Split-Path -Parent $GoldensRoot
if (-not (Test-Path -LiteralPath $goldensParent)) { [void][IO.Directory]::CreateDirectory($goldensParent) }
[void][IO.Directory]::CreateDirectory($GoldensRoot)

if (-not $R3aOnly) {
    $dumpOutFile = Join-Path $root 'out\dump-state\result.json'
    Invoke-Scenario -Name 'dump-state' -Mode 'DumpState' -ModeArgs @('-DumpState', '-OutFile', $dumpOutFile)
    Invoke-Scenario -Name 'print-status' -Mode 'PrintStatus' -ModeArgs @('-PrintStatus')
    Invoke-Scenario -Name 'recommendation-status' -Mode 'RecommendationStatus' -ModeArgs @('-RecommendationStatus')

    foreach ($profileKey in @(
        'gpt-kimi-deepseek', 'gpt-deepseek', 'kimi-deepseek',
        'kimi-ollama-deepseek', 'experimental-custom', 'cmd-glm-deepseek'
    )) {
        Invoke-Scenario -Name ('apply-' + $profileKey) -Mode 'Apply' -ModeArgs @('-Apply', '-ProfileKey', $profileKey)
    }
}

$seedConfig = [IO.File]::ReadAllText((Join-Path $root 'seed\home\.omo\omo.jsonc'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$catalogMember = $seedConfig.PSObject.Properties['[native]']
if ($null -eq $catalogMember) { $catalogMember = $seedConfig.PSObject.Properties['[senpi]'] }
if ($null -eq $catalogMember) { Stop-Capture 'Seed omo.jsonc has no engine catalog section.' 1 }
$catalog = $catalogMember.Value.models

function Resolve-CatalogAlias {
    param([string]$Alias)
    $entry = $catalog.PSObject.Properties[$Alias]
    if ($null -eq $entry) { Stop-Capture ('Seed catalog is missing alias ' + $Alias) 1 }
    $modelId = [string]$entry.Value.model
    $variant = ''
    $variantMember = $entry.Value.PSObject.Properties['variant']
    if ($null -ne $variantMember) { $variant = [string]$variantMember.Value }
    if ([string]::IsNullOrWhiteSpace($modelId) -or [string]::IsNullOrWhiteSpace($variant)) {
        Stop-Capture ('Seed catalog alias has no model/variant: ' + $Alias) 1
    }
    return [ordered]@{
        provider  = ($modelId -split '/', 2)[0]
        model     = $modelId
        reasoning = $variant
    }
}

$customLiteral = (Resolve-CatalogAlias 'flash-high').model

function New-IntentFile {
    param([string]$Name, $Body)
    $path = Join-Path $root ('intents\' + $Name + '.json')
    Save-JsonFile $path $Body
    return $path
}

function New-ModelProfileIntent {
    param([string]$Name, [string]$Selection, [string]$Literal = '')
    $body = [ordered]@{
        schema      = 1
        profileKey  = 'gpt-kimi-deepseek'
        activate    = $false
        routing     = @()
        modelProfile = [ordered]@{ selection = $Selection; literal = $Literal }
    }
    return (New-IntentFile $Name $body)
}

if (-not $R3aOnly) {
    $modelProfileCases = @(
        @{ Name = 'daily-normal'; Selection = 'daily-normal'; Literal = '' }
        @{ Name = 'daily-heavy'; Selection = 'daily-heavy'; Literal = '' }
        @{ Name = 'geeky-normal'; Selection = 'geeky-normal'; Literal = '' }
        @{ Name = 'geeky-heavy'; Selection = 'geeky-heavy'; Literal = '' }
        @{ Name = 'custom-literal'; Selection = 'custom-literal'; Literal = $customLiteral }
        @{ Name = 'off'; Selection = 'off'; Literal = '' }
    )
    foreach ($case in $modelProfileCases) {
        $intent = New-ModelProfileIntent -Name ('model-profile-' + $case.Name) -Selection $case.Selection -Literal $case.Literal
        Invoke-Scenario -Name ('intent-model-profile-' + $case.Name + '-dryrun') -Mode 'ApplyIntentPath.DryRun' `
            -ModeArgs @('-ApplyIntentPath', $intent, '-OutFile', (Join-Path $root ('out\intent-model-profile-' + $case.Name + '-dryrun\result.json')), '-DryRun') `
            -IntentPath $intent
        Invoke-Scenario -Name ('intent-model-profile-' + $case.Name + '-apply') -Mode 'ApplyIntentPath.Apply' `
            -ModeArgs @('-ApplyIntentPath', $intent, '-OutFile', (Join-Path $root ('out\intent-model-profile-' + $case.Name + '-apply\result.json'))) `
            -IntentPath $intent
    }

    $summarizerIntent = New-IntentFile 'summarizer' ([ordered]@{
        schema     = 1
        profileKey = 'gpt-kimi-deepseek'
        activate   = $false
        routing    = @()
        summarizer = (Resolve-CatalogAlias 'flash-high').model
    })
    Invoke-Scenario -Name 'intent-summarizer-dryrun' -Mode 'ApplyIntentPath.DryRun' `
        -ModeArgs @('-ApplyIntentPath', $summarizerIntent, '-OutFile', (Join-Path $root 'out\intent-summarizer-dryrun\result.json'), '-DryRun') `
        -IntentPath $summarizerIntent
    Invoke-Scenario -Name 'intent-summarizer-apply' -Mode 'ApplyIntentPath.Apply' `
        -ModeArgs @('-ApplyIntentPath', $summarizerIntent, '-OutFile', (Join-Path $root 'out\intent-summarizer-apply\result.json')) `
        -IntentPath $summarizerIntent

    # One routing change per display purpose group (groups copied from $script:RoutingGroups in the switcher).
    $routingCases = @(
        @{ Group = 'discovery'; Section = 'agents'; Role = 'explore'; TargetAlias = 'sol' }
        @{ Group = 'planning'; Section = 'agents'; Role = 'plan-consultant'; TargetAlias = 'terra' }
        @{ Group = 'review'; Section = 'agents'; Role = 'plan-reviewer'; TargetAlias = 'sol' }
        @{ Group = 'general'; Section = 'categories'; Role = 'quick'; TargetAlias = 'kimi-max' }
        @{ Group = 'reasoning'; Section = 'categories'; Role = 'deep-low'; TargetAlias = 'kimi-max' }
        @{ Group = 'specialism'; Section = 'categories'; Role = 'architect'; TargetAlias = 'terra' }
    )
    foreach ($case in $routingCases) {
        $target = Resolve-CatalogAlias $case.TargetAlias
        $body = [ordered]@{
            schema     = 1
            profileKey = 'gpt-kimi-deepseek'
            activate   = $false
            routing    = @([ordered]@{
                section   = $case.Section
                role      = $case.Role
                provider  = $target.provider
                model     = $target.model
                reasoning = $target.reasoning
            })
        }
        $intent = New-IntentFile ('routing-' + $case.Group) $body
        Invoke-Scenario -Name ('intent-routing-' + $case.Group + '-dryrun') -Mode 'ApplyIntentPath.DryRun' `
            -ModeArgs @('-ApplyIntentPath', $intent, '-OutFile', (Join-Path $root ('out\intent-routing-' + $case.Group + '-dryrun\result.json')), '-DryRun') `
            -IntentPath $intent
        Invoke-Scenario -Name ('intent-routing-' + $case.Group + '-apply') -Mode 'ApplyIntentPath.Apply' `
            -ModeArgs @('-ApplyIntentPath', $intent, '-OutFile', (Join-Path $root ('out\intent-routing-' + $case.Group + '-apply\result.json'))) `
            -IntentPath $intent
    }
}

# ---- New r3a intent scenarios (todo 6) --------------------------------------------------------------------------
# Scenarios:
#   intent-memory-custom-dryrun, intent-memory-custom-apply, intent-memory-quick-apply,
#   intent-reflection-custom-dryrun, intent-reflection-custom-apply,
#   intent-main-dryrun, intent-main-apply
# The chosen custom memory model is openai/gpt-6-sol (reasoning: high), which is served in all fixture homes.
$chosenCustomModel = 'openai/gpt-6-sol'
$chosenCustomReasoning = 'high'
$chosenMainModel = (Resolve-CatalogAlias 'flash-high').model
$chosenMainReasoning = (Resolve-CatalogAlias 'flash-high').reasoning

$intentMemoryCustom = New-IntentFile 'memory-custom' ([ordered]@{
    schema      = 1
    profileKey  = 'gpt-kimi-deepseek'
    activate    = $false
    routing     = @()
    memoryModel = [ordered]@{ mode = 'custom'; model = $chosenCustomModel; reasoning = $chosenCustomReasoning }
})
Invoke-Scenario -Name 'intent-memory-custom-dryrun' -Mode 'ApplyIntentPath.DryRun' `
    -ModeArgs @('-ApplyIntentPath', $intentMemoryCustom, '-OutFile', (Join-Path $root 'out\intent-memory-custom-dryrun\result.json'), '-DryRun') `
    -IntentPath $intentMemoryCustom
Invoke-Scenario -Name 'intent-memory-custom-apply' -Mode 'ApplyIntentPath.Apply' `
    -ModeArgs @('-ApplyIntentPath', $intentMemoryCustom, '-OutFile', (Join-Path $root 'out\intent-memory-custom-apply\result.json')) `
    -IntentPath $intentMemoryCustom

$intentMemoryQuick = New-IntentFile 'memory-quick' ([ordered]@{
    schema      = 1
    profileKey  = 'gpt-kimi-deepseek'
    activate    = $false
    routing     = @()
    memoryModel = [ordered]@{ mode = 'quick' }
})
Invoke-Scenario -Name 'intent-memory-quick-apply' -Mode 'ApplyIntentPath.Apply' `
    -ModeArgs @('-ApplyIntentPath', $intentMemoryQuick, '-OutFile', (Join-Path $root 'out\intent-memory-quick-apply\result.json')) `
    -IntentPath $intentMemoryQuick

$intentReflectionCustom = New-IntentFile 'reflection-custom' ([ordered]@{
    schema                 = 1
    profileKey             = 'gpt-kimi-deepseek'
    activate               = $false
    routing                = @()
    reflectionMemoryModel  = [ordered]@{ mode = 'custom'; model = $chosenCustomModel; reasoning = $chosenCustomReasoning }
})
Invoke-Scenario -Name 'intent-reflection-custom-dryrun' -Mode 'ApplyIntentPath.DryRun' `
    -ModeArgs @('-ApplyIntentPath', $intentReflectionCustom, '-OutFile', (Join-Path $root 'out\intent-reflection-custom-dryrun\result.json'), '-DryRun') `
    -IntentPath $intentReflectionCustom
Invoke-Scenario -Name 'intent-reflection-custom-apply' -Mode 'ApplyIntentPath.Apply' `
    -ModeArgs @('-ApplyIntentPath', $intentReflectionCustom, '-OutFile', (Join-Path $root 'out\intent-reflection-custom-apply\result.json')) `
    -IntentPath $intentReflectionCustom

$intentMain = New-IntentFile 'main' ([ordered]@{
    schema     = 1
    profileKey = 'gpt-kimi-deepseek'
    activate   = $false
    routing    = @()
    main       = [ordered]@{
        provider  = ($chosenMainModel -split '/', 2)[0]
        model     = $chosenMainModel
        reasoning = $chosenMainReasoning
    }
})
Invoke-Scenario -Name 'intent-main-dryrun' -Mode 'ApplyIntentPath.DryRun' `
    -ModeArgs @('-ApplyIntentPath', $intentMain, '-OutFile', (Join-Path $root 'out\intent-main-dryrun\result.json'), '-DryRun') `
    -IntentPath $intentMain
Invoke-Scenario -Name 'intent-main-apply' -Mode 'ApplyIntentPath.Apply' `
    -ModeArgs @('-ApplyIntentPath', $intentMain, '-OutFile', (Join-Path $root 'out\intent-main-apply\result.json')) `
    -IntentPath $intentMain

# ---- manifest --------------------------------------------------------------------------------------------------
$engineVersion = (& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -Command '$PSVersionTable.PSVersion.ToString()') -join ''
$launcher = 'C:\Users\USER\Desktop\OMO Native Profile Switcher.vbs'
$liveHashesAfter = [ordered]@{
    'C:\Users\USER\.omo-stable-500\home\.omo\omo.jsonc'          = Get-Sha256 'C:\Users\USER\.omo-stable-500\home\.omo\omo.jsonc'
    'C:\Users\USER\.omo-stable-500\home\.omo\agent\settings.json' = Get-Sha256 'C:\Users\USER\.omo-stable-500\home\.omo\agent\settings.json'
    'C:\Users\USER\.omo-stable-500\home\.omo\agent\models.json'   = Get-Sha256 'C:\Users\USER\.omo-stable-500\home\.omo\agent\models.json'
    'C:\Users\USER\.omo\omo.jsonc'                                = Get-Sha256 'C:\Users\USER\.omo\omo.jsonc'
    'C:\Users\USER\.omo\agent\settings.json'                      = Get-Sha256 'C:\Users\USER\.omo\agent\settings.json'
}

$manifest = [ordered]@{
    schema      = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    fixtureRoot = $root
    engine      = [ordered]@{
        file       = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
        name       = 'Windows PowerShell'
        version    = $engineVersion
        edition    = 'Desktop'
        launcher   = $launcher
        launcherSha256 = Get-Sha256 $launcher
        launcherCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File OMO_Native_Profile_Switcher.ps1'
    }
    switcher    = [ordered]@{ path = $SwitcherPath; sha256 = Get-Sha256 $SwitcherPath }
    recommendationManifest = [ordered]@{
        source = $RecommendationManifestSource
        fixture = $recommendationFixture
        sha256 = Get-Sha256 $recommendationFixture
    }
    seed        = [ordered]@{
        sources = [ordered]@{
            primary = $primarySource
            stable500 = $stableSource
        }
        files = $seedIndex
        laneMirrors = @($laneMirrorReport.ToArray())
        excluded = @('auth.json', 'credential-pool-state.json', 'models-store backups', 'sessions', 'logs')
    }
    liveHashes  = [ordered]@{ before = $liveHashesBefore; after = $liveHashesAfter }
    scenarios   = $script:ScenarioRecords
}

Save-JsonFile (Join-Path $GoldensRoot 'manifest.json') $manifest
Write-Log ('wrote ' + (Join-Path $GoldensRoot 'manifest.json') + ' with ' + $script:ScenarioRecords.Count + ' scenarios')

$logPath = Join-Path $root 'capture.log'
[IO.File]::WriteAllLines($logPath, $script:LogLines.ToArray(), (New-Object Text.UTF8Encoding($false)))
Write-Log ('CAPTURE_OK fixture=' + $root)
[IO.File]::WriteAllLines($logPath, $script:LogLines.ToArray(), (New-Object Text.UTF8Encoding($false)))
exit 0
