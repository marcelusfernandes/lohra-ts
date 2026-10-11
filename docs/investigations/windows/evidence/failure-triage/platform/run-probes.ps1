param(
    [Parameter(Mandatory = $true)][ValidateSet('node20', 'node22')][string]$Label,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$Clone,
    [Parameter(Mandatory = $true)][string]$ProbeRoot
)

$ErrorActionPreference = 'Stop'
$absoluteRoot = [System.IO.Path]::GetFullPath($ProbeRoot)
$taskRoot = [System.IO.Path]::GetFullPath('F:\lohra-m25-753')
if (-not $absoluteRoot.StartsWith($taskRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'ProbeRoot must be inside the task-owned F: directory'
}
if (Test-Path -LiteralPath $absoluteRoot) { throw 'ProbeRoot must be new' }
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'Node executable missing' }
if (-not (Test-Path -LiteralPath (Join-Path $Clone 'node_modules\better-sqlite3') -PathType Container)) {
    throw 'ABI-specific better-sqlite3 missing'
}
New-Item -ItemType Directory -Path $absoluteRoot | Out-Null
New-Item -ItemType File -Path (Join-Path $absoluteRoot '.lohra-owned-platform-probe') | Out-Null

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

$probe = Join-Path $PSScriptRoot 'probe.mjs'
$results = @()
foreach ($scenario in @('permission', 'signal-int', 'signal-term', 'sqlite')) {
    $output = & $NodeExe $probe $scenario $absoluteRoot $Clone 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Probe $scenario failed with exit $exitCode; inspect task-owned case directories without deleting them"
    }
    $line = @($output | ForEach-Object { $_.ToString() })[-1]
    $parsed = $line | ConvertFrom-Json
    if ($parsed.scenario -ne $scenario) { throw "Probe $scenario returned the wrong scenario" }
    $results += [pscustomobject]@{ scenario = $scenario; exitCode = $exitCode; result = $parsed }
}
$report = [pscustomobject]@{
    label = $Label
    node = (& $NodeExe --version)
    cloneSha = (git -C $Clone rev-parse HEAD)
    scenarios = $results
}
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $PSScriptRoot "results-$Label.json") -Encoding utf8
$report | ConvertTo-Json -Depth 12
