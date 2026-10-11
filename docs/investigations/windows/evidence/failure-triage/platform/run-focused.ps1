param(
    [Parameter(Mandatory = $true)][ValidateSet('node20', 'node22')][string]$Label,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$Clone,
    [Parameter(Mandatory = $true)][string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$absoluteRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$taskRoot = [System.IO.Path]::GetFullPath('F:\lohra-m25-753')
if (-not $absoluteRoot.StartsWith($taskRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputRoot must be inside the task-owned F: directory'
}
if (Test-Path -LiteralPath $absoluteRoot) { throw 'OutputRoot must be new' }
New-Item -ItemType Directory -Path $absoluteRoot | Out-Null
$env:TEMP = Join-Path $absoluteRoot 'temp'
$env:TMP = $env:TEMP
$env:HOME = Join-Path $absoluteRoot 'home'
$env:USERPROFILE = $env:HOME
$env:LOHRA_HOME = Join-Path $absoluteRoot 'lohra-home'
$env:CODEX_HOME = Join-Path $absoluteRoot 'codex-home'
$env:APPDATA = Join-Path $absoluteRoot 'appdata'
$env:LOCALAPPDATA = Join-Path $absoluteRoot 'localappdata'
$env:NPM_CONFIG_CACHE = Join-Path $absoluteRoot 'npm-cache'
$env:NPM_CONFIG_PREFIX = Join-Path $absoluteRoot 'npm-prefix'
foreach ($path in @($env:TEMP, $env:HOME, $env:LOHRA_HOME, $env:CODEX_HOME, $env:APPDATA, $env:LOCALAPPDATA, $env:NPM_CONFIG_CACHE, $env:NPM_CONFIG_PREFIX)) {
    New-Item -ItemType Directory -Path $path | Out-Null
}
$env:PATH = (Split-Path -Parent $NodeExe) + [System.IO.Path]::PathSeparator + $env:PATH
$vitest = Join-Path $Clone 'node_modules\vitest\vitest.mjs'
$groups = [ordered]@{
    permission = @('tests/auth-core.test.ts', 'tests/media-persistence.test.ts')
    signal = @('tests/mutations-all.test.ts', 'tests/cli-serve-process.test.ts')
    sqlite = @('tests/gateway/session-service.test.ts')
}
$results = @()
foreach ($group in $groups.Keys) {
    $reporter = Join-Path $absoluteRoot ($group + '-vitest.json')
    $arguments = @($vitest, 'run') + $groups[$group] + @('--maxWorkers=1', '--reporter=json', "--outputFile=$reporter")
    Push-Location -LiteralPath $Clone
    try {
        $output = & $NodeExe @arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    @($output | ForEach-Object { $_.ToString() }) | Set-Content -LiteralPath (Join-Path $absoluteRoot ($group + '.log')) -Encoding utf8
    $counts = $null
    if (Test-Path -LiteralPath $reporter) {
        $report = Get-Content -LiteralPath $reporter -Raw | ConvertFrom-Json
        $counts = [pscustomobject]@{
            total = $report.numTotalTests
            passed = $report.numPassedTests
            failed = $report.numFailedTests
            pending = $report.numPendingTests
        }
    }
    $results += [pscustomobject]@{ group = $group; files = $groups[$group]; exitCode = $exitCode; counts = $counts }
}
$summary = [pscustomobject]@{
    label = $Label
    node = (& $NodeExe --version)
    cloneSha = (git -C $Clone rev-parse HEAD)
    groups = $results
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $PSScriptRoot "focused-$Label.json") -Encoding utf8
$summary | ConvertTo-Json -Depth 8
