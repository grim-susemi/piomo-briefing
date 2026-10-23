# flow-map.ps1: WinForms probe, flow-map generator, and capture harness for switcher-flow-restore
param(
    [string]$FixtureRoot = $null,
    [string]$OutDir = $null,
    [switch]$OnlyRefusalTest = $false,
    [switch]$SkipCaptures = $false,
    [string]$CaptureTask = $null,
    [string]$CaptureResolution = $null
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Get-FullPath([string]$Path) {
    return ([IO.Path]::GetFullPath($Path)).TrimEnd([char[]]@('\', '/'))
}

function Assert-FixtureRootIsSafe([string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Root)) { throw "FixtureRoot is empty." }
    $full = Get-FullPath $Root
    foreach ($live in @($LiveRoots + $LiveHomes)) {
        $liveFull = Get-FullPath $live
        if ($full -ieq $liveFull -or
            $full.StartsWith($liveFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $liveFull.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw ("REFUSAL: Fixture root is or overlaps a live home: {0} (live: {1}). Refusing before any switcher run." -f $full, $liveFull)
        }
    }
    if (-not $full.StartsWith($TempParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw ("REFUSAL: Fixture root must be a child of {0}: {1}" -f $TempParent, $full)
    }
    return $full
}

if ($OnlyRefusalTest) {
    try {
        Assert-FixtureRootIsSafe $FixtureRoot
        Write-Host "NOT_REFUSED"
    } catch {
        Write-Host $_.Exception.Message
    }
    exit 0
}

# Validate FixtureRoot
if (-not [string]::IsNullOrWhiteSpace($FixtureRoot)) {
    $Root = Assert-FixtureRootIsSafe $FixtureRoot
} else {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
    $Root = Assert-FixtureRootIsSafe (Join-Path $TempParent ('sfr-flow-' + $stamp))
}

if (-not (Test-Path -LiteralPath $Root)) {
    [void][IO.Directory]::CreateDirectory($Root)
}

$SwitcherPath = 'C:/Users/USER/Desktop/OpenCode_Modes/OMO_Native_Profile_Switcher.ps1'
$RecommendationManifestSource = 'C:/Users/USER/Desktop/OpenCode_Modes/OMO_Native_Recommendation.json'

if (-not [string]::IsNullOrWhiteSpace($OutDir)) {
    $EvidenceDir = $OutDir
} else {
    $EvidenceDir = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/switcher-flow-restore/task-3'
}
[void][IO.Directory]::CreateDirectory($EvidenceDir)

Write-Host "Fixture root: $Root"
Write-Host "Evidence dir: $EvidenceDir"

# Initialize fixture directories
$homeOmo = Join-Path $Root 'home\.omo'
$homeStable = Join-Path $Root 'home\.omo-stable-500\home\.omo'
[void][IO.Directory]::CreateDirectory($homeOmo)
[void][IO.Directory]::CreateDirectory((Join-Path $homeOmo 'agent'))
[void][IO.Directory]::CreateDirectory((Join-Path $homeOmo 'runtime'))
[void][IO.Directory]::CreateDirectory((Join-Path $homeOmo 'runtime\native-profile-switcher-backups'))
[void][IO.Directory]::CreateDirectory($homeStable)
[void][IO.Directory]::CreateDirectory((Join-Path $homeStable 'agent'))

# Seed files
Copy-Item 'C:\Users\USER\.omo\omo.jsonc' (Join-Path $homeOmo 'omo.jsonc')
Copy-Item 'C:\Users\USER\.omo\agent\settings.json' (Join-Path $homeOmo 'agent\settings.json')
Copy-Item 'C:\Users\USER\.omo-stable-500\home\.omo\omo.jsonc' (Join-Path $homeStable 'omo.jsonc')

# Seed agent/models.json from stage registry fixture!
$stageRegPrimary = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/switcher-flow-restore/task-3/stage/test/fixtures/profiles/registry/primary/agent/models.json'
Copy-Item $stageRegPrimary (Join-Path $homeOmo 'agent\models.json')
$stageRegStable = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/switcher-flow-restore/task-3/stage/test/fixtures/profiles/registry/stable/agent/models.json'
Copy-Item $stageRegStable (Join-Path $homeStable 'agent\models.json')

$paths = @{
    ConfigPath = (Join-Path $homeOmo 'omo.jsonc')
    SettingsPath = (Join-Path $homeOmo 'agent\settings.json')
    ModelsPath = (Join-Path $homeOmo 'agent\models.json')
    MainOverridePath = (Join-Path $homeOmo 'runtime\main.json')
    SubscriptionsPath = (Join-Path $homeOmo 'subscriptions.json')
    BackupDirectory = (Join-Path $homeOmo 'runtime\native-profile-switcher-backups')
    RecommendationStatePath = (Join-Path $homeOmo 'runtime\recommendation.json')
    Stable500HomePath = $homeStable
}

$env:USERPROFILE = (Join-Path $Root 'home')
$switcherRoot = 'C:/Users/USER/Desktop/OpenCode_Modes'

# Record fixtureHash
$fixtureHash = (Get-FileHash -LiteralPath (Join-Path $homeOmo 'agent\models.json') -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "fixtureHash: $fixtureHash"

# Part 1: LayoutProbe for 1180x700 and 1600x900
$probe1180Json = powershell -NoProfile -File $SwitcherPath -LayoutProbe -ProbeWidth 1180 -ProbeHeight 700
$probe1180 = $probe1180Json | ConvertFrom-Json

$probe1600Json = powershell -NoProfile -File $SwitcherPath -LayoutProbe -ProbeWidth 1600 -ProbeHeight 900
$probe1600 = $probe1600Json | ConvertFrom-Json

# Part 2: Dot-source probe to inspect WinForms control bounds and cascade
$source = [IO.File]::ReadAllText($SwitcherPath)
$cutoff = $source.LastIndexOf('if (-not [string]::IsNullOrWhiteSpace($CapturePath))')
$source = $source.Substring(0, $cutoff)
$source = $source.Replace('$PSScriptRoot', '$switcherRoot')

$formRef = $null
$cascade = @()

try {
    . ([scriptblock]::Create($source)) @paths -InitialProfileKey experimental-custom -LaneMirrorRoots @()
    $formRef = $form
    $form.Show()
    [Windows.Forms.Application]::DoEvents()

    function Get-ComboVal($c) {
        if ($null -eq $c.SelectedItem) { return '' }
        if ($c.SelectedItem -is [string]) { return [string]$c.SelectedItem }
        if ($null -ne $c.SelectedItem.PSObject.Properties['Tag']) { return [string]$c.SelectedItem.Tag }
        return [string]$c.SelectedItem
    }

    # Extract Regions (WinForms coordinates)
    $regions = @(
        [ordered]@{
            id = 'status'
            box = [ordered]@{ x = $statusPanel.Left; y = $statusPanel.Top; w = $statusPanel.Width; h = $statusPanel.Height }
        },
        [ordered]@{
            id = 'guide'
            box = [ordered]@{ x = $recommendationButton.Left; y = $recommendationButton.Top; w = $recommendationButton.Width; h = $recommendationButton.Height }
        },
        [ordered]@{
            id = 'cards'
            box = [ordered]@{ x = $probe1180.Cards.X; y = $probe1180.Cards.Y; w = $probe1180.Cards.Width; h = $probe1180.Cards.Height }
        },
        [ordered]@{
            id = 'detail'
            box = [ordered]@{ x = $probe1180.Detail.X; y = $probe1180.Detail.Y; w = $probe1180.Detail.Width; h = $probe1180.Detail.Height }
        },
        [ordered]@{
            id = 'roles'
            box = [ordered]@{ x = $script:RoutingContainer.Left; y = $script:RoutingContainer.Top; w = $script:RoutingContainer.Width; h = $script:RoutingContainer.Height }
        },
        [ordered]@{
            id = 'lane'
            box = [ordered]@{ x = $script:ModelProfileCombo.Left; y = $script:ModelProfileCombo.Top; w = ($script:ModelProfileLiteral.Right - $script:ModelProfileCombo.Left); h = 28 }
        },
        [ordered]@{
            id = 'main'
            box = [ordered]@{ x = $script:MainProviderCombo.Left; y = $script:MainProviderCombo.Top; w = ($script:MainThinkingCombo.Right - $script:MainProviderCombo.Left); h = 28 }
        },
        [ordered]@{
            id = 'summarizer'
            box = [ordered]@{ x = $script:SummarizerProviderCombo.Left; y = $script:SummarizerProviderCombo.Top; w = ($script:SummarizerModelCombo.Right - $script:SummarizerProviderCombo.Left); h = 28 }
        },
        [ordered]@{
            id = 'apply'
            box = [ordered]@{ x = $script:DetailApplyButton.Left; y = $script:DetailApplyButton.Top; w = $script:DetailApplyButton.Width; h = $script:DetailApplyButton.Height }
        },
        [ordered]@{
            id = 'message'
            box = [ordered]@{ x = $probe1180.Message.X; y = $probe1180.Message.Y; w = $probe1180.Message.Width; h = $probe1180.Message.Height }
        }
    )

    # Inspect control bounds for steps
    $roleSection = 'agents'
    $roleName = 'explore'
    $roleWinFormsKey = "$roleSection-$roleName"

    $roleRow = $script:RoutingContainer.Controls["RoutingRow-$roleWinFormsKey"]
    $sCombo = $roleRow.Controls["RoutingService-$roleWinFormsKey"]
    $mCombo = $roleRow.Controls["RoutingModel-$roleWinFormsKey"]
    $eCombo = $roleRow.Controls["RoutingReasoning-$roleWinFormsKey"]

    $stepRoleS = [ordered]@{
        control = "role:$($roleSection)/$($roleName):service"
        region = 'roles'
        box = [ordered]@{ x = $sCombo.Left; y = ($roleRow.Top + $sCombo.Top); w = $sCombo.Width; h = $sCombo.Height }
        scrolls = [int][Math]::Ceiling([Math]::Max(0, ($roleRow.Bottom - $script:RoutingContainer.Height)) / [double]$script:RoutingContainer.Height)
    }
    $stepRoleM = [ordered]@{
        control = "role:$($roleSection)/$($roleName):model"
        region = 'roles'
        box = [ordered]@{ x = $mCombo.Left; y = ($roleRow.Top + $mCombo.Top); w = $mCombo.Width; h = $mCombo.Height }
        scrolls = $stepRoleS.scrolls
    }
    $stepRoleE = [ordered]@{
        control = "role:$($roleSection)/$($roleName):effort"
        region = 'roles'
        box = [ordered]@{ x = $eCombo.Left; y = ($roleRow.Top + $eCombo.Top); w = $eCombo.Width; h = $eCombo.Height }
        scrolls = $stepRoleS.scrolls
    }
    $stepRoleApply = [ordered]@{
        control = 'apply:detail'
        region = 'apply'
        box = [ordered]@{ x = $script:DetailApplyButton.Left; y = $script:DetailApplyButton.Top; w = $script:DetailApplyButton.Width; h = $script:DetailApplyButton.Height }
        scrolls = [int][Math]::Ceiling([Math]::Max(0, ($script:DetailApplyButton.Bottom - $probe1180.Detail.Height)) / [double]$probe1180.Detail.Height)
    }

    $memRow = $script:RoutingContainer.Controls['MemoryModelRow']
    $modeCombo = $memRow.Controls['MemoryModeSelector']
    $memSCombo = $memRow.Controls['MemoryServiceSelector']
    $memMCombo = $memRow.Controls['MemoryModelSelector']
    $memECombo = $memRow.Controls['MemoryReasoningSelector']

    $stepMemMode = [ordered]@{
        control = 'memory:kibitzer:mode'
        region = 'roles'
        box = [ordered]@{ x = $modeCombo.Left; y = ($memRow.Top + $modeCombo.Top); w = $modeCombo.Width; h = $modeCombo.Height }
        scrolls = 0
    }
    $stepMemS = [ordered]@{
        control = 'memory:kibitzer:service'
        region = 'roles'
        box = [ordered]@{ x = $memSCombo.Left; y = ($memRow.Top + $memSCombo.Top); w = $memSCombo.Width; h = $memSCombo.Height }
        scrolls = 0
    }
    $stepMemM = [ordered]@{
        control = 'memory:kibitzer:model'
        region = 'roles'
        box = [ordered]@{ x = $memMCombo.Left; y = ($memRow.Top + $memMCombo.Top); w = $memMCombo.Width; h = $memMCombo.Height }
        scrolls = 0
    }
    $stepMemE = [ordered]@{
        control = 'memory:kibitzer:effort'
        region = 'roles'
        box = [ordered]@{ x = $memECombo.Left; y = ($memRow.Top + $memECombo.Top); w = $memECombo.Width; h = $memECombo.Height }
        scrolls = 0
    }

    # Profile task step
    $cardPanel = @($cardsPanel.Controls | Where-Object { $_ -is [System.Windows.Forms.Panel] -and $_.Tag.Key -eq 'gpt-deepseek' })[0]
    $cardApplyBtn = $cardPanel.Controls['CardApplyButton']
    $stepProfApply = [ordered]@{
        control = 'apply:card:gpt-deepseek'
        region = 'cards'
        box = [ordered]@{ x = ($cardPanel.Left + $cardApplyBtn.Left); y = ($cardPanel.Top + $cardApplyBtn.Top); w = $cardApplyBtn.Width; h = $cardApplyBtn.Height }
        scrolls = [int][Math]::Ceiling([Math]::Max(0, ($cardPanel.Bottom - $cardsPanel.Height)) / [double]$cardsPanel.Height)
    }

    # Perform cascade recordings
    # 1. Role: agents-explore
    $beforeRoleS = [ordered]@{ service = Get-ComboVal $sCombo; model = Get-ComboVal $mCombo; effort = Get-ComboVal $eCombo }
    $newServiceItem = ($sCombo.Items | Where-Object { $_.Tag -eq 'openai-opencodex' })[0]
    $sCombo.SelectedItem = $newServiceItem
    [Windows.Forms.Application]::DoEvents()
    $afterRoleS = [ordered]@{ service = Get-ComboVal $sCombo; model = Get-ComboVal $mCombo; effort = Get-ComboVal $eCombo }
    $cascade += [ordered]@{
        kind = 'role'
        change = 'service'
        before = $beforeRoleS
        after = $afterRoleS
        cite = 'PS:5757-5768 (Update-RoutingModelCombo / Update-RoutingReasoningCombo on provider SelectedIndexChanged)'
    }

    $beforeRoleM = $afterRoleS
    $newModelItem = ($mCombo.Items | Where-Object { $_.Tag -eq 'openai-opencodex/gpt-5.6-sol' })[0]
    $mCombo.SelectedItem = $newModelItem
    [Windows.Forms.Application]::DoEvents()
    $afterRoleM = [ordered]@{ service = Get-ComboVal $sCombo; model = Get-ComboVal $mCombo; effort = Get-ComboVal $eCombo }
    $cascade += [ordered]@{
        kind = 'role'
        change = 'model'
        before = $beforeRoleM
        after = $afterRoleM
        cite = 'PS:5769-5778 (Update-RoutingReasoningCombo on model SelectedIndexChanged)'
    }

    # 2. Main row
    # Main Case B: switch to service whose list does not hold current model
    $beforeMainB = [ordered]@{ service = Get-ComboVal $script:MainProviderCombo; model = Get-ComboVal $script:MainModelCombo; effort = Get-ComboVal $script:MainThinkingCombo }
    $provNoHold = ($script:MainProviderCombo.Items | Where-Object { $_.Tag -eq 'openai-opencodex' })[0]
    $script:MainProviderCombo.SelectedItem = $provNoHold
    [Windows.Forms.Application]::DoEvents()
    $afterMainB = [ordered]@{ service = Get-ComboVal $script:MainProviderCombo; model = Get-ComboVal $script:MainModelCombo; effort = Get-ComboVal $script:MainThinkingCombo }
    $cascade += [ordered]@{
        kind = 'main'
        change = 'service'
        case = 'service whose list does not hold current model'
        before = $beforeMainB
        after = $afterMainB
        cite = 'PS:7447-7478 (Update-MainModelCombo clears uncommitted model when not in new provider list)'
    }

    # Select model under openai-opencodex
    $beforeMainM = $afterMainB
    $script:MainModelCombo.SelectedItem = $script:MainModelCombo.Items[0]
    [Windows.Forms.Application]::DoEvents()
    $afterMainM = [ordered]@{ service = Get-ComboVal $script:MainProviderCombo; model = Get-ComboVal $script:MainModelCombo; effort = Get-ComboVal $script:MainThinkingCombo }
    $cascade += [ordered]@{
        kind = 'main'
        change = 'model'
        before = $beforeMainM
        after = $afterMainM
        cite = 'PS:7479-7495 (Update-MainThinkingCombo updates reasoning choices on main model change)'
    }

    # Main Case A: switch to service whose list holds current model (e.g. opencode)
    $beforeMainA = $afterMainM
    $provHold = ($script:MainProviderCombo.Items | Where-Object { $_.Tag -eq 'opencode' })[0]
    $script:MainProviderCombo.SelectedItem = $provHold
    [Windows.Forms.Application]::DoEvents()
    $afterMainA = [ordered]@{ service = Get-ComboVal $script:MainProviderCombo; model = Get-ComboVal $script:MainModelCombo; effort = Get-ComboVal $script:MainThinkingCombo }
    $cascade += [ordered]@{
        kind = 'main'
        change = 'service'
        case = 'service whose list holds current model'
        before = $beforeMainA
        after = $afterMainA
        cite = 'PS:7455-7467 (Committed model match by suffix retains selection across compatible providers)'
    }

    # 3. Memory row (Kibitzer)
    $beforeMemMode = [ordered]@{ mode = Get-ComboVal $modeCombo; service = Get-ComboVal $memSCombo; model = Get-ComboVal $memMCombo; effort = Get-ComboVal $memECombo }
    $customModeItem = ($modeCombo.Items | Where-Object { $_.Tag -eq 'custom' })[0]
    $modeCombo.SelectedItem = $customModeItem
    [Windows.Forms.Application]::DoEvents()
    $afterMemMode = [ordered]@{ mode = Get-ComboVal $modeCombo; service = Get-ComboVal $memSCombo; model = Get-ComboVal $memMCombo; effort = Get-ComboVal $memECombo }

    # Change memory service
    $beforeMemS = $afterMemMode
    $newMemSItem = ($memSCombo.Items | Where-Object { $_.Tag -eq 'antigravity-ocx' })[0]
    if ($null -eq $newMemSItem) { $newMemSItem = $memSCombo.Items[0] }
    $memSCombo.SelectedItem = $newMemSItem
    [Windows.Forms.Application]::DoEvents()
    $afterMemS = [ordered]@{ service = Get-ComboVal $memSCombo; model = Get-ComboVal $memMCombo; effort = Get-ComboVal $memECombo }
    $cascade += [ordered]@{
        kind = 'memory'
        change = 'service'
        before = $beforeMemS
        after = $afterMemS
        cite = 'PS:5798-5801, 5999 (Update-MemoryRoutingControls clears model and thinking when service changes)'
    }

    # Change memory model
    $beforeMemM = $afterMemS
    $newMemMItem = ($memMCombo.Items | Where-Object { $_.Tag -ne (Get-ComboVal $memMCombo) })[0]
    $memMCombo.SelectedItem = $newMemMItem
    [Windows.Forms.Application]::DoEvents()
    $afterMemM = [ordered]@{ service = Get-ComboVal $memSCombo; model = Get-ComboVal $memMCombo; effort = Get-ComboVal $memECombo }
    $cascade += [ordered]@{
        kind = 'memory'
        change = 'model'
        before = $beforeMemM
        after = $afterMemM
        cite = 'PS:5801-5802, 6000 (Update-MemoryRoutingControls clears thinking when model changes)'
    }

    # Build flow-map JSON structure
    $flowMap = [ordered]@{
        schema = 'flow-map/1'
        source = 'winforms'
        fixtureHash = $fixtureHash
        frame = [ordered]@{
            width = $probe1180.Width
            height = $probe1180.Height
            inner = [ordered]@{ w = 1180; h = 700 }
            sidebar = $true
        }
        regions = $regions
        sections = @(
            'kibitzer',
            'reflection',
            'agents:explore-research',
            'agents:plan-advice',
            'agents:review-qa',
            'categories:quick-general',
            'categories:deep',
            'categories:specialist',
            'lane',
            'main',
            'summarizer',
            'apply'
        )
        rows = [ordered]@{
            role = [ordered]@{
                component = 'New-RoutingRow'
                cite = 'PS:5595-5785'
                captions = @('1. 구독 서비스', '2. AI 모델', '3. 추론 강도')
                captionsCite = 'PS:5645'
                staging = 'Pending apply on confirm; persists when all three set'
                stagingCite = 'PS:5721-5734'
                placeholderEmpty = $true
                placeholderCite = 'PS:5704-5711'
            }
            memory = [ordered]@{
                kibitzerComponent = 'New-MemoryRoutingRow'
                reflectionComponent = 'New-ReflectionMemoryRoutingRow'
                cite = 'PS:5790-6056'
                modes = @('quick 공유 (기본)', '직접 선택')
                modesCite = 'PS:5935-5936'
            }
            summarizer = [ordered]@{
                component = 'SummarizerProviderCombo / SummarizerModelCombo'
                cite = 'PS:4292-4340'
                firstItem = '원본 기본 컴팩션'
                firstItemCite = 'PS:4390'
            }
            main = [ordered]@{
                component = 'MainProviderCombo / MainModelCombo / MainThinkingCombo'
                cite = 'PS:4243-4289'
                save = 'Save-MainModelOverride'
                saveCite = 'PS:7475, 7494'
            }
        }
        tasks = [ordered]@{
            role = @(
                [ordered]@{ control = 'card:experimental-custom'; region = 'cards'; box = [ordered]@{ x = 0; y = 640; w = 481; h = 152 }; scrolls = 1 },
                $stepRoleS,
                $stepRoleM,
                $stepRoleE,
                $stepRoleApply
            )
            profile = @(
                $stepProfApply
            )
            memory = @(
                $stepMemMode,
                $stepMemS,
                $stepMemM,
                $stepMemE,
                $stepRoleApply
            )
        }
    }

    # Save flow-map.winforms.json to stage, repo and outDir
    $flowMapJson = $flowMap | ConvertTo-Json -Depth 10
    $stagePath = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/switcher-flow-restore/task-3/stage/test/fixtures/profiles/flow-map.winforms.json'
    if (Test-Path -LiteralPath (Split-Path $stagePath -Parent)) {
        [IO.File]::WriteAllText($stagePath, $flowMapJson, (New-Object Text.UTF8Encoding($false)))
    }
    $repoPath = Join-Path $PSScriptRoot 'flow-map.winforms.json'
    if (Test-Path -LiteralPath $repoPath) {
        [IO.File]::WriteAllText($repoPath, $flowMapJson, (New-Object Text.UTF8Encoding($false)))
    }
    if ($EvidenceDir -ne 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/switcher-flow-restore/task-3') {
        [IO.File]::WriteAllText((Join-Path $EvidenceDir 'flow-map.winforms.json'), $flowMapJson, (New-Object Text.UTF8Encoding($false)))
    }

    # Save cascade.json to evidence
    $cascadeJson = $cascade | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText((Join-Path $EvidenceDir 'cascade.json'), $cascadeJson, (New-Object Text.UTF8Encoding($false)))

} finally {
    if ($formRef) { $formRef.Close(); $formRef.Dispose() }
}

Write-Host "Part 1 & 2 completed!"

if ($SkipCaptures) {
    Write-Host "Skipping captures per -SkipCaptures."
    exit 0
}

# Part 3: Captures
Write-Host "Starting Captures..."

Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WinformsUnifiedCapture { [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags); }'

function Save-FormCapture([System.Windows.Forms.Form]$TargetForm, [string]$SavePath) {
    $TargetForm.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    $bmp = New-Object System.Drawing.Bitmap($TargetForm.Width, $TargetForm.Height)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        try {
            if (-not [WinformsUnifiedCapture]::PrintWindow($TargetForm.Handle, $hdc, 2)) { throw "PrintWindow failed" }
        } finally {
            $g.ReleaseHdc($hdc)
            $g.Dispose()
        }
        $bmp.Save($SavePath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bmp.Dispose()
    }
}

$allSizes = @(
    @{ Name = '1180x700'; W = 1196; H = 739 },
    @{ Name = '1600x900'; W = 1616; H = 939 }
)

$sizes = if ([string]::IsNullOrWhiteSpace($CaptureResolution)) {
    $allSizes
} else {
    @($allSizes | Where-Object { $_.Name -eq $CaptureResolution })
}

$captureScriptBlock = [scriptblock]::Create($source)

foreach ($s in $sizes) {
    $sizeName = $s.Name
    $w = $s.W
    $h = $s.H

    if ([string]::IsNullOrWhiteSpace($CaptureTask) -or $CaptureTask -eq 'role') {
        $capRole = Join-Path $EvidenceDir ("winforms-role-" + $sizeName + ".png")
        Write-Host "Capturing Role: $capRole"
        $roleForm = $null
        try {
            . $captureScriptBlock @paths -InitialProfileKey experimental-custom -LaneMirrorRoots @()
            $roleForm = $form
            $form.Width = $w
            $form.Height = $h
            $form.Show()
            [Windows.Forms.Application]::DoEvents()
            
            $providerControl = @($form.Controls.Find("RoutingService-agents-explore", $true))[0]
            $modelControl = @($form.Controls.Find("RoutingModel-agents-explore", $true))[0]
            $reasoningControl = @($form.Controls.Find("RoutingReasoning-agents-explore", $true))[0]
            $previousRoutingSuppressChange = $script:RoutingComboSuppressChange
            $script:RoutingComboSuppressChange = $true
            try {
                Set-ComboSelectionByTag -Combo $providerControl -Tag 'opencode-go'
                [System.Windows.Forms.Application]::DoEvents()
                Update-RoutingModelCombo -Combo $modelControl -Catalog $script:Config.'[senpi]'.models -Provider 'opencode-go' -SelectedModel 'opencode-go/muse-spark-1.3-contributor'
                [System.Windows.Forms.Application]::DoEvents()
                Update-RoutingReasoningCombo -Combo $reasoningControl -Catalog $script:Config.'[senpi]'.models -Provider 'opencode-go' -Model 'opencode-go/muse-spark-1.3-contributor' -SelectedReasoning 'medium'
                [System.Windows.Forms.Application]::DoEvents()
            } finally {
                $script:RoutingComboSuppressChange = $previousRoutingSuppressChange
            }
            $providerControl.Parent.Parent.ScrollControlIntoView($providerControl.Parent)
            [System.Windows.Forms.Application]::DoEvents()

            Save-FormCapture -TargetForm $form -SavePath $capRole
        } finally {
            if ($roleForm) { $roleForm.Close(); $roleForm.Dispose() }
        }
    }

    if ([string]::IsNullOrWhiteSpace($CaptureTask) -or $CaptureTask -eq 'profile') {
        $capProfile = Join-Path $EvidenceDir ("winforms-profile-" + $sizeName + ".png")
        Write-Host "Capturing Profile: $capProfile"
        $profForm = $null
        try {
            . $captureScriptBlock @paths -InitialProfileKey gpt-deepseek -LaneMirrorRoots @()
            $profForm = $form
            $form.Width = $w
            $form.Height = $h
            $form.Show()
            [Windows.Forms.Application]::DoEvents()

            Save-FormCapture -TargetForm $form -SavePath $capProfile
        } finally {
            if ($profForm) { $profForm.Close(); $profForm.Dispose() }
        }
    }

    if ([string]::IsNullOrWhiteSpace($CaptureTask) -or $CaptureTask -eq 'memory') {
        $capMemory = Join-Path $EvidenceDir ("winforms-memory-" + $sizeName + ".png")
        Write-Host "Capturing Memory task: $capMemory"
        $memForm = $null
        try {
            . $captureScriptBlock @paths -InitialProfileKey experimental-custom -LaneMirrorRoots @()
            $memForm = $form
            $form.Width = $w
            $form.Height = $h
            $form.Show()
            [Windows.Forms.Application]::DoEvents()
            
            $mRow = $script:RoutingContainer.Controls['MemoryModelRow']
            $mSelector = $mRow.Controls['MemoryModeSelector']
            $customOpt = ($mSelector.Items | Where-Object { $_.Tag -eq 'custom' })[0]
            $mSelector.SelectedItem = $customOpt
            [Windows.Forms.Application]::DoEvents()

            Save-FormCapture -TargetForm $form -SavePath $capMemory
        } finally {
            if ($memForm) { $memForm.Close(); $memForm.Dispose() }
        }
    }
}

Write-Host "Captures Finished Successfully!"
