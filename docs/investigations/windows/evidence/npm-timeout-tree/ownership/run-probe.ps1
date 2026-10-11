param(
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [Parameter(Mandatory = $true)][string]$NpmCli,
  [Parameter(Mandatory = $true)][string]$OutputRoot,
  [Parameter(Mandatory = $true)][string]$IsolationRoot,
  [Parameter(Mandatory = $true)][string]$Tag
)

$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$probeRoot = [IO.Path]::GetFullPath($OutputRoot)
$isolationDir = [IO.Path]::GetFullPath($IsolationRoot)
if (Test-Path -LiteralPath $probeRoot) { throw "PROBE_OUTPUT_EXISTS:$probeRoot" }
if ($probeRoot -eq $isolationDir) { throw 'PROBE_ROOT_EQUALS_ISOLATION' }
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'NODE_EXE_MISSING' }
if (-not (Test-Path -LiteralPath $NpmCli -PathType Leaf)) { throw 'NPM_CLI_MISSING' }
New-Item -ItemType Directory -Path $probeRoot | Out-Null
foreach ($name in @('tmp', 'lohra', 'codex', 'npm-cache', 'npm-prefix')) {
  New-Item -ItemType Directory -Path (Join-Path $isolationDir $name) -Force | Out-Null
}
$env:HOME = $isolationDir
$env:USERPROFILE = $isolationDir
$env:LOHRA_HOME = Join-Path $isolationDir 'lohra'
$env:CODEX_HOME = Join-Path $isolationDir 'codex'
$env:TEMP = Join-Path $isolationDir 'tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $isolationDir 'npm-cache'
$env:npm_config_prefix = Join-Path $isolationDir 'npm-prefix'
$env:npm_config_userconfig = Join-Path $isolationDir 'user.npmrc'
$env:npm_config_globalconfig = Join-Path $isolationDir 'global.npmrc'
$env:npm_config_offline = 'true'

$compileWatch = [Diagnostics.Stopwatch]::StartNew()
Add-Type -Path (Join-Path $sourceDir 'job-probe.cs')
$compileWatch.Stop()
$results = @()
$modes = @('normal', 'timeout', 'uncontained-control', 'create-failure', 'assign-failure', 'resume-failure', 'query-failure', 'termination-failure', 'atomic-normal', 'atomic-invalid-job')
foreach ($mode in $modes) {
  $scenarioDir = Join-Path $probeRoot $mode
  New-Item -ItemType Directory -Path $scenarioDir | Out-Null
  foreach ($name in @('middle.cjs', 'child.cjs', 'control.cjs')) {
    Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $scenarioDir $name)
  }
  $nodeQuoted = '"' + $NodeExe + '"'
  $middleQuoted = '"' + (Join-Path $scenarioDir 'middle.cjs') + '"'
  $scriptCommand = 'call ' + $nodeQuoted + ' ' + $middleQuoted + ' "space & value"'
  @{ name = 'lohra-owned-job-probe'; version = '0.0.0'; scripts = @{ probe = $scriptCommand } } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $scenarioDir 'package.json') -Encoding utf8
  $env:PROBE_DIR = $scenarioDir
  $env:PROBE_TOKEN = "OWN-$Tag-$mode"
  $result = if ($mode -eq 'atomic-normal') {
    [OwnedJobProbe]::RunAtomic($NodeExe, $NpmCli, $scenarioDir, $false)
  } elseif ($mode -eq 'atomic-invalid-job') {
    [OwnedJobProbe]::RunAtomic($NodeExe, $NpmCli, $scenarioDir, $true)
  } else {
    [OwnedJobProbe]::Run($NodeExe, $NpmCli, $scenarioDir, $mode)
  }
  $results += $result
}
Remove-Item Env:PROBE_DIR -ErrorAction SilentlyContinue
Remove-Item Env:PROBE_TOKEN -ErrorAction SilentlyContinue

$report = [ordered]@{
  tag = $Tag
  nodeVersion = (& $NodeExe --version)
  platform = [Environment]::OSVersion.VersionString
  sourcesSha256 = [ordered]@{}
  compileMs = $compileWatch.ElapsedMilliseconds
  results = $results
}
foreach ($name in @('job-probe.cs', 'run-probe.ps1', 'middle.cjs', 'child.cjs', 'control.cjs')) {
  $report.sourcesSha256[$name] = (Get-FileHash -Algorithm SHA256 (Join-Path $sourceDir $name)).Hash
}
$violations = @()
foreach ($result in $results) {
  if ($result.Failure -or ($result.Mode -notin @('create-failure', 'atomic-invalid-job') -and -not $result.CreatedSuspended) -or $result.MarkerBeforeResume -or $result.ActiveAfter -ne 0) {
    $violations += "INVARIANT:$($result.Mode)"
  }
}
$normal = @($results | Where-Object Mode -eq 'normal')[0]
$timeout = @($results | Where-Object Mode -eq 'timeout')[0]
$uncontained = @($results | Where-Object Mode -eq 'uncontained-control')[0]
$createFailure = @($results | Where-Object Mode -eq 'create-failure')[0]
$assignFailure = @($results | Where-Object Mode -eq 'assign-failure')[0]
$resumeFailure = @($results | Where-Object Mode -eq 'resume-failure')[0]
$queryFailure = @($results | Where-Object Mode -eq 'query-failure')[0]
$terminationFailure = @($results | Where-Object Mode -eq 'termination-failure')[0]
$atomic = @($results | Where-Object Mode -eq 'atomic-normal')[0]
$atomicInvalid = @($results | Where-Object Mode -eq 'atomic-invalid-job')[0]
if (-not ($normal.Assigned -and $normal.Resumed -and $normal.MiddleMarker -and $normal.ChildMarker -and $normal.LateMarker -and $normal.TotalAssociated -ge 4)) { $violations += 'NORMAL' }
if (-not ($timeout.Assigned -and $timeout.Resumed -and $timeout.ActiveBefore -ge 4 -and $timeout.OwnJobTerminated -and $timeout.MiddleMarker -and $timeout.ChildMarker -and -not $timeout.LateMarker -and $timeout.ExternalControlMarker)) { $violations += 'TIMEOUT' }
if (-not (-not $uncontained.Assigned -and $uncontained.Resumed -and $uncontained.MiddleMarker -and $uncontained.ChildMarker -and $uncontained.LateMarker -and $uncontained.TotalAssociated -eq 0)) { $violations += 'UNCONTAINED_CONTROL' }
if (-not (-not $createFailure.CreatedSuspended -and $createFailure.CreateError -eq 2 -and -not $createFailure.MiddleMarker)) { $violations += 'CREATE_FAILURE' }
if (-not (-not $assignFailure.Assigned -and $assignFailure.AssignError -eq 6 -and -not $assignFailure.Resumed -and -not $assignFailure.MiddleMarker)) { $violations += 'ASSIGN_FAILURE' }
if (-not ($resumeFailure.Assigned -and -not $resumeFailure.Resumed -and $resumeFailure.ResumeError -eq 6 -and $resumeFailure.OwnJobTerminated -and -not $resumeFailure.MiddleMarker)) { $violations += 'RESUME_FAILURE' }
if (-not ($queryFailure.QueryFailureObserved -and $queryFailure.QueryError -eq 6 -and $queryFailure.OwnJobTerminated)) { $violations += 'QUERY_FAILURE' }
if (-not ($terminationFailure.TerminationFailureObserved -and $terminationFailure.TerminationError -eq 6 -and $terminationFailure.OwnJobTerminated)) { $violations += 'TERMINATION_FAILURE' }
if (-not ($atomic.CreatedSuspended -and $atomic.Assigned -and $atomic.ActiveBefore -eq 1 -and $atomic.Resumed -and $atomic.TotalAssociated -ge 4 -and $atomic.MiddleMarker -and $atomic.ChildMarker -and $atomic.LateMarker)) { $violations += 'ATOMIC_NORMAL' }
if (-not (-not $atomicInvalid.CreatedSuspended -and $atomicInvalid.CreateError -eq 6 -and -not $atomicInvalid.MiddleMarker)) { $violations += 'ATOMIC_INVALID_JOB' }
$report.violations = $violations
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $probeRoot 'results.json') -Encoding utf8
foreach ($result in $results) {
  '{0}: assigned={1} resumed={2} activeAfter={3} external={4} failure={5}' -f $result.Mode,
    $result.Assigned, $result.Resumed, $result.ActiveAfter, $result.ExternalControlMarker, $result.Failure
}
if ($violations.Count -gt 0) { throw ('PROBE_ASSERTIONS_FAILED:' + ($violations -join ',')) }
