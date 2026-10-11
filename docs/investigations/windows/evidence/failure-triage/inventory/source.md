# Fontes das sondas externas de #751

As fontes abaixo foram executadas em F: e não alteram o repositório. A suíte foi executada uma vez por Node no SHA `ebeb722f898bdb4cde5b7d7cef66fb40febf5c15`. Os projetores foram reexecutados sobre os mesmos JSONs brutos após correções de sanitização; não houve repetição da suíte.

## Runner PowerShell

<!-- prettier-ignore -->
```powershell
# Sonda externa de #751. Nao execute antes de fixar SHA com o orquestrador.
# Resultados brutos ficam apenas em F:. Nao copia logs integrais para Git.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Sha,
  [string]$Root = 'F:\lohra-751-runs',
  [int]$CloneTimeoutMinutes = 10,
  [int]$InstallTimeoutMinutes = 15,
  [int]$TestTimeoutMinutes = 20
)
$ErrorActionPreference = 'Stop'
$runtime = @(
  @{ label = 'node20'; exe = 'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node.exe'; npm = 'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node_modules\npm\bin\npm-cli.js' },
  @{ label = 'node22'; exe = 'C:\Program Files\nodejs\node.exe'; npm = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' }
)
$git = (Get-Command git -ErrorAction Stop).Source
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$runDir = Join-Path $Root ("$($Sha.Substring(0, 12))-$stamp")
if (Test-Path -LiteralPath $runDir) { throw "run directory already exists: $runDir" }
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

function Invoke-Bounded {
  param([string]$Exe, [string[]]$Argv, [string]$WorkDir, [string]$Name, [string]$Scenario, [int]$Minutes)
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $Exe
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($arg in $Argv) { [void]$psi.ArgumentList.Add($arg) }
  $psi.Environment['HOME'] = Join-Path $Scenario 'home'
  $psi.Environment['USERPROFILE'] = Join-Path $Scenario 'home'
  $psi.Environment['LOHRA_HOME'] = Join-Path $Scenario 'home\lohra'
  $psi.Environment['CODEX_HOME'] = Join-Path $Scenario 'home\codex'
  $psi.Environment['TEMP'] = Join-Path $Scenario 'tmp'
  $psi.Environment['TMP'] = Join-Path $Scenario 'tmp'
  $psi.Environment['npm_config_cache'] = Join-Path $Scenario 'npm-cache'
  $psi.Environment['npm_config_prefix'] = Join-Path $Scenario 'npm-prefix'
  $psi.Environment['PATH'] = (Split-Path -Parent $Exe) + [IO.Path]::PathSeparator + $psi.Environment['PATH']
  foreach ($path in @('home', 'home\lohra', 'home\codex', 'tmp', 'npm-cache', 'npm-prefix')) {
    New-Item -ItemType Directory -Path (Join-Path $Scenario $path) -Force | Out-Null
  }
  $started = (Get-Date).ToUniversalTime()
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync()
  $err = $p.StandardError.ReadToEndAsync()
  $timedOut = -not $p.WaitForExit($Minutes * 60000)
  $terminationError = $null
  if ($timedOut) {
    # Mata somente o processo que esta sonda iniciou e seus descendentes.
    try { $p.Kill($true) } catch { $terminationError = $_.Exception.ToString() }
    [void]$p.WaitForExit(5000)
  }
  $hasExited = $p.HasExited
  $stdoutClosed = $out.Wait(5000)
  $stderrClosed = $err.Wait(5000)
  $stdoutPath = Join-Path $Scenario "$Name.stdout.raw.log"
  $stderrPath = Join-Path $Scenario "$Name.stderr.raw.log"
  [IO.File]::WriteAllText($stdoutPath, $(if ($stdoutClosed) { $out.GetAwaiter().GetResult() } else { '<OUTPUT_STREAM_NOT_CLOSED>' }))
  [IO.File]::WriteAllText($stderrPath, $(if ($stderrClosed) { $err.GetAwaiter().GetResult() } else { '<ERROR_STREAM_NOT_CLOSED>' }))
  $result = [ordered]@{
    command = @($Exe) + $Argv
    startedUtc = $started.ToString('o')
    elapsedSeconds = [math]::Round(((Get-Date).ToUniversalTime() - $started).TotalSeconds, 3)
    pid = $p.Id
    exit = if ($timedOut -or -not $hasExited) { $null } else { $p.ExitCode }
    timeout = $timedOut
    hasExited = $hasExited
    terminationError = $terminationError
    outputStreamsClosed = $stdoutClosed -and $stderrClosed
    stdoutSha256 = (Get-FileHash -LiteralPath $stdoutPath -Algorithm SHA256).Hash.ToLowerInvariant()
    stderrSha256 = (Get-FileHash -LiteralPath $stderrPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $p.Dispose()
  return $result
}

$all = [ordered]@{ schema = 1; sha = $Sha; host = 'Windows-x64'; stampUtc = $stamp; runs = @() }
foreach ($entry in $runtime) {
  $scenario = Join-Path $runDir $entry.label
  New-Item -ItemType Directory -Path $scenario -Force | Out-Null
  $node = $entry.exe
  $npm = $entry.npm
  if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $npm)) {
    throw "missing pinned runtime for $($entry.label)"
  }
  $nodeVersion = (& $node --version).Trim()
  $clone = Join-Path $scenario 'clone'
  $steps = [ordered]@{}
  $steps.clone = Invoke-Bounded -Exe $git -Argv @('clone', '--no-checkout', 'https://github.com/marcelusfernandes/lohra-ts.git', $clone) -WorkDir $runDir -Name 'clone' -Scenario $scenario -Minutes $CloneTimeoutMinutes
  if ($steps.clone.exit -eq 0) {
    $steps.checkout = Invoke-Bounded -Exe $git -Argv @('-C', $clone, 'checkout', '--detach', $Sha) -WorkDir $runDir -Name 'checkout' -Scenario $scenario -Minutes $CloneTimeoutMinutes
  }
  if ($steps.checkout.exit -eq 0) {
    $steps.head = Invoke-Bounded -Exe $git -Argv @('-C', $clone, 'rev-parse', 'HEAD') -WorkDir $runDir -Name 'head' -Scenario $scenario -Minutes 1
    $headText = [IO.File]::ReadAllText((Join-Path $scenario 'head.stdout.raw.log'))
    $steps.headMatches = $steps.head.exit -eq 0 -and $headText.Trim() -eq $Sha
    $steps.status = Invoke-Bounded -Exe $git -Argv @('-C', $clone, 'status', '--porcelain') -WorkDir $runDir -Name 'status' -Scenario $scenario -Minutes 1
    $statusText = [IO.File]::ReadAllText((Join-Path $scenario 'status.stdout.raw.log'))
    $steps.checkoutClean = $steps.status.exit -eq 0 -and -not $statusText.Trim()
    $steps.protectNtfs = Invoke-Bounded -Exe $git -Argv @('-C', $clone, 'config', '--show-origin', '--get', 'core.protectNTFS') -WorkDir $runDir -Name 'protect-ntfs' -Scenario $scenario -Minutes 1
    $steps.autocrlf = Invoke-Bounded -Exe $git -Argv @('-C', $clone, 'config', '--show-origin', '--get', 'core.autocrlf') -WorkDir $runDir -Name 'autocrlf' -Scenario $scenario -Minutes 1
    if ($steps.headMatches -and $steps.checkoutClean) {
      $steps.install = Invoke-Bounded -Exe $node -Argv @($npm, 'ci') -WorkDir $clone -Name 'npm-ci' -Scenario $scenario -Minutes $InstallTimeoutMinutes
    }
  }
  if ($steps.install.exit -eq 0) {
    $json = Join-Path $scenario 'vitest.raw.json'
    $steps.test = Invoke-Bounded -Exe $node -Argv @($npm, 'test', '--', '--maxWorkers=4', '--reporter=json', "--outputFile=$json") -WorkDir $clone -Name 'test' -Scenario $scenario -Minutes $TestTimeoutMinutes
    if (Test-Path -LiteralPath $json) {
      $steps.reporterSha256 = (Get-FileHash -LiteralPath $json -Algorithm SHA256).Hash.ToLowerInvariant()
      $projection = Join-Path $scenario 'inventory.sanitized.json'
      $steps.sanitize = Invoke-Bounded -Exe $node -Argv @((Join-Path $PSScriptRoot 'sanitize-vitest.mjs'), $json, $clone, $projection, $nodeVersion, $Sha) -WorkDir $scenario -Name 'sanitize' -Scenario $scenario -Minutes 2
    }
  }
  $status = if ($steps.clone.exit -ne 0 -or $steps.checkout.exit -ne 0 -or -not $steps.headMatches -or -not $steps.checkoutClean -or $steps.install.exit -ne 0 -or
    -not $steps.clone.hasExited -or -not $steps.checkout.hasExited -or -not $steps.install.hasExited -or
    -not $steps.clone.outputStreamsClosed -or -not $steps.checkout.outputStreamsClosed -or -not $steps.install.outputStreamsClosed) { 'BLOCKED' }
    elseif ($steps.test.timeout -or -not $steps.test.hasExited -or -not $steps.test.outputStreamsClosed -or -not $steps.Contains('reporterSha256') -or $steps.sanitize.exit -ne 0) { 'BLOCKED' }
    elseif ($steps.test.exit -eq 0) { 'PASS' } else { 'FAIL' }
  $all.runs += [ordered]@{ node = $nodeVersion; label = $entry.label; status = $status; steps = $steps }
  $all | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runDir 'run.raw.json') -Encoding utf8
}
Write-Output $runDir
```

## Sanitização do reporter

<!-- prettier-ignore -->
```js
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep, win32 } from 'node:path';

const [rawPath, cloneRoot, outputPath, nodeVersion, sha] = process.argv.slice(2);
if (!rawPath || !cloneRoot || !outputPath || !nodeVersion || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
  throw new Error('usage: sanitize-vitest.mjs RAW_JSON CLONE_ROOT OUTPUT NODE_VERSION SHA40');
}
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
if (!raw || !Array.isArray(raw.testResults)) throw new Error('Vitest JSON missing testResults');

function sanitize(value) {
  return String(value ?? '')
    // Vitest sometimes embeds a path as escaped text inside an assertion diff.
    .replace(/\\{2,}/g, '\\')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replaceAll(resolve(cloneRoot), '<CLONE>')
    .replaceAll(resolve(cloneRoot).replaceAll('\\', '/'), '<CLONE>')
    .replace(/[A-Za-z]:[\\/](?:Users[\\/][^\\/\s:'"]+|lohra-[^\s:'"]+)(?:[\\/][^\s:)'\"]*)?/gi, '<LOCAL_PATH>')
    .replace(/[A-Za-z]:[\\/]<CLONE>/gi, '<CLONE>')
    .replace(/file:\/\/\/[A-Za-z]:[\\/]<CLONE>/gi, '<CLONE>')
    .replace(/file:\/\/\/[A-Za-z]:[\\/][^\s'"<>)]*/gi, '<LOCAL_PATH>')
    .replace(/\b[A-Za-z]:[\\/][^\s'"<>)]*/g, '<LOCAL_PATH>')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+/gi, 'Bearer <REDACTED>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '<REDACTED>')
    .replace(/\b((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)\s*[:=]\s*)[^\s,;]+/gi, '$1<REDACTED>');
}

function repoPath(absolute) {
  if (typeof absolute !== 'string') throw new Error('testResults[].name missing');
  const path = relative(resolve(cloneRoot), resolve(absolute));
  if (path === '..' || path.startsWith(`..${sep}`) || resolve(path) === resolve(absolute)) {
    throw new Error('testResults[].name outside clone root');
  }
  return path.replaceAll('\\', '/');
}

function primary(message) {
  const lines = sanitize(message).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // A child process can wrap its real module error in an AssertionError whose
  // first non-empty line is only a Node internal frame. Prefer the explicit
  // coded cause from the same failureMessage when it exists.
  return lines.find((line) => /^Error \[[A-Z_]+\]:/.test(line)) ??
    lines.find((line) =>
    /(?:Error|AssertionError|TypeError|ENOENT|EBUSY|failed|timeout)/i.test(line) &&
    !/^(?:AssertionError|Error):\s*$/.test(line)) ??
    lines.find((line) => /(?:Error|AssertionError|TypeError|ENOENT|EBUSY|failed|timeout)/i.test(line)) ??
    lines[0] ?? '<NO_MESSAGE>';
}

function shortDetail(message) {
  return sanitize(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s|^file:\/\//i.test(line))
    .slice(0, 8)
    .join(' | ')
    .slice(0, 600);
}

function fileOperation(message) {
  const match = /\b(unlink|rmdir|open|rename)\s+['"]?([^'"\r\n]+)/i.exec(String(message ?? ''));
  if (!match) return null;
  const basename = win32.basename(match[2].trim());
  const stableBasename = basename.startsWith('lohra-')
    ? basename.replace(/-[A-Za-z0-9]{6,}$/, '-<RANDOM>')
    : basename;
  return { operation: match[1].toLowerCase(), targetBasename: sanitize(stableBasename) };
}

function signature(message) {
  const normalized = primary(message)
    .replace(/\b0x[0-9a-f]+\b/gi, '<HEX>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<ID>')
    .replace(/:\d+(?::\d+)?\b/g, ':<LINE>')
    .replace(/\b\d+(?:\.\d+)?\s?ms\b/gi, '<DURATION>');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${digest}:${normalized.slice(0, 160)}`;
}

const files = [];
const failures = [];
const suiteErrors = [];
const fileDiagnostics = [];
const observed = { passed: 0, failed: 0, pending: 0, skipped: 0, todo: 0, unknown: 0 };
for (const file of raw.testResults) {
  const path = repoPath(file.name);
  const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
  const status = String(file.status ?? 'unknown');
  files.push({ file: path, status, assertions: assertions.length });
  if (status === 'failed' && typeof file.message === 'string' && file.message.trim()) {
    fileDiagnostics.push({ file: path, message: primary(file.message), signature: signature(file.message) });
  }
  if (status === 'failed' && assertions.length === 0) {
    const message = primary(file.message);
    suiteErrors.push({ file: path, message, signature: signature(file.message) });
  }
  for (const assertion of assertions) {
    const state = String(assertion.status ?? 'unknown');
    if (state === 'passed') observed.passed++;
    else if (state === 'failed') observed.failed++;
    else if (state === 'pending') observed.pending++;
    else if (state === 'skipped') observed.skipped++;
    else if (state === 'todo') observed.todo++;
    else observed.unknown++;
    if (state !== 'failed') continue;
    const messages = Array.isArray(assertion.failureMessages)
      ? assertion.failureMessages.filter((item) => typeof item === 'string')
      : [];
    const error = messages[0] ?? file.message ?? '<NO_MESSAGE>';
    const message = primary(error);
    const secondary = messages.slice(1).map((item, index) => ({
      order: index + 2,
      message: primary(item),
      signature: signature(item),
      fileOperation: fileOperation(item),
    }));
    const failure = { file: path, test: sanitize(assertion.fullName ?? assertion.title ?? '<UNNAMED>'), message, signature: signature(error), fileOperation: fileOperation(error), secondary };
    if (/^(?:AssertionError|Error):\s*$/.test(message)) failure.detail = shortDetail(error);
    failures.push(failure);
  }
}
files.sort((a, b) => a.file.localeCompare(b.file));
failures.sort((a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test));
suiteErrors.sort((a, b) => a.file.localeCompare(b.file));
fileDiagnostics.sort((a, b) => a.file.localeCompare(b.file));
const unhandledErrors = Array.isArray(raw.unhandledErrors)
  ? raw.unhandledErrors.map((item) => {
      const message = typeof item === 'string' ? item : item?.message ?? JSON.stringify(item);
      return { message: primary(message), signature: signature(message) };
    })
  : [];
const unhandledErrorsStatus = Array.isArray(raw.unhandledErrors) ? 'EXPOSED' : 'NOT_REPORTED';
const reported = {
  suitesTotal: raw.numTotalTestSuites,
  suitesPassed: raw.numPassedTestSuites,
  suitesFailed: raw.numFailedTestSuites,
  suitesPending: raw.numPendingTestSuites,
  fileResults: raw.testResults.length,
  testsTotal: raw.numTotalTests,
  testsPassed: raw.numPassedTests,
  testsFailed: raw.numFailedTests,
  testsPending: raw.numPendingTests,
  testsTodo: raw.numTodoTests,
  success: raw.success,
};
const reconciliation = {
  unknownStatusesZero: observed.unknown === 0,
  fileResultsMatch: reported.fileResults === files.length,
  testsMatch: reported.testsTotal === observed.passed + observed.failed + observed.pending + observed.skipped + observed.todo + observed.unknown,
  passedMatch: reported.testsPassed === observed.passed,
  failedMatch: reported.testsFailed === observed.failed,
  pendingMatch: reported.testsPending === observed.pending + observed.skipped,
  todoMatch: reported.testsTodo === observed.todo,
  failedAssertionsMatch: failures.length === observed.failed,
  suiteErrorsMatch: suiteErrors.length === files.filter((item) => item.status === 'failed' && item.assertions === 0).length,
};
const result = { schema: 1, sha, platform: 'win32-x64', node: nodeVersion, reported, observed, reconciliation, files, failures, suiteErrors, fileDiagnostics, unhandledErrorsStatus, unhandledErrors };
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
if (Object.values(reconciliation).some((value) => !value)) process.exitCode = 2;
```

## Empacotamento da evidência

<!-- prettier-ignore -->
```js
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { release, arch } from 'node:os';

const [runDir, outputDir] = process.argv.slice(2);
if (!runDir || !outputDir) throw new Error('usage: package-evidence.mjs RUN_DIR OUTPUT_DIR');
mkdirSync(outputDir, { recursive: true });
const run = JSON.parse(readFileSync(join(runDir, 'run.raw.json'), 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const jsonl = (path, values) => writeFileSync(path, values.map((value) => JSON.stringify(value)).join('\n') + '\n');

function sanitizeLog(line) {
  return line
    .replace(/\\{2,}/g, '\\')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/file:\/\/\/[A-Za-z]:[\\/][^\s'"<>)]*/gi, '<LOCAL_PATH>')
    .replace(/\b[A-Za-z]:[\\/][^\s'"<>)]*/g, '<LOCAL_PATH>')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+/gi, 'Bearer <REDACTED>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '<REDACTED>')
    .replace(/\b((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)\s*[:=]\s*)[^\s,;]+/gi, '$1<REDACTED>');
}

const summary = { schema: 1, sha: run.sha, host: run.host, status: {}, comparisons: {} };
const failureSets = new Map();
const fileSets = new Map();
const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
for (const label of ['node20', 'node22']) {
  const execution = run.runs.find((item) => item.label === label);
  if (!execution) throw new Error(`missing ${label} execution`);
  const root = join(runDir, label);
  const report = JSON.parse(readFileSync(join(root, 'inventory.sanitized.json'), 'utf8'));
  if (Object.values(report.reconciliation).some((value) => !value)) throw new Error(`${label} not reconciled`);
  if (execution.status !== 'FAIL' && execution.status !== 'PASS') throw new Error(`${label} setup blocked`);
  const failures = report.failures.map((failure) => ({
    id: createHash('sha256').update(`${failure.file}\u0000${failure.test}`).digest('hex').slice(0, 16),
    ...failure,
  }));
  jsonl(join(outputDir, `failures-${label}.jsonl`), failures);
  fileSets.set(label, new Map(report.files.map((item) => [item.file, { status: item.status, assertions: item.assertions }])));
  const stderrPath = join(root, 'test.stderr.raw.log');
  const stderr = readFileSync(stderrPath, 'utf8');
  const diagnostics = stderr.split(/\r?\n/).map(sanitizeLog).filter(Boolean)
    .map((message, index) => ({ source: 'stderr', category: 'UNATTRIBUTED_DIAGNOSTIC', order: index + 1, message }));
  jsonl(join(outputDir, `stderr-${label}.jsonl`), diagnostics);
  const hashes = {};
  for (const [name, step] of Object.entries(execution.steps)) {
    if (!step || typeof step !== 'object' || !('stdoutSha256' in step)) continue;
    hashes[name] = { stdoutSha256: step.stdoutSha256, stderrSha256: step.stderrSha256, exit: step.exit, timeout: step.timeout, hasExited: step.hasExited, elapsedSeconds: step.elapsedSeconds };
  }
  const nodeExe = label === 'node20'
    ? 'F:\\lohra-m25-761-runtime\\node-v20.20.2-win-x64\\node.exe'
    : 'C:\\Program Files\\nodejs\\node.exe';
  const npmCli = label === 'node20'
    ? 'F:\\lohra-m25-761-runtime\\node-v20.20.2-win-x64\\node_modules\\npm\\bin\\npm-cli.js'
    : 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const npmVersion = execFileSync(nodeExe, [npmCli, '--version'], { encoding: 'utf8' }).trim();
  const metadata = {
    schema: 1,
    sha: run.sha,
    platform: 'Windows 11 x64 native',
    osBuild: release(),
    architecture: arch(),
    gitVersion,
    node: execution.node,
    npmVersion,
    status: execution.status,
    clone: 'git clone --no-checkout; git checkout --detach SHA (no core.protectNTFS override)',
    gitConfig: { autocrlf: 'true (system config)', protectNTFS: 'unset (no override)' },
    testCommand: 'node.exe npm-cli.js test -- --maxWorkers=4 --reporter=json --outputFile=<TEMP>/vitest.raw.json',
    steps: hashes,
    rawReporterSha256: sha256(join(root, 'vitest.raw.json')),
    rawStderrSha256: sha256(stderrPath),
    reported: report.reported,
    observed: report.observed,
    reconciliation: report.reconciliation,
    failedFileResults: report.files.filter((item) => item.status === 'failed').length,
    assertionFailures: failures.length,
    secondaryMessages: failures.reduce((sum, item) => sum + item.secondary.length, 0),
    collectionErrors: report.suiteErrors.length,
    fileDiagnostics: report.fileDiagnostics.length,
    unhandledErrorsStatus: report.unhandledErrorsStatus,
    stderrDiagnostics: diagnostics.length,
  };
  json(join(outputDir, `metadata-${label}.json`), metadata);
  summary.status[label] = metadata;
  failureSets.set(label, new Map(failures.map((failure) => [failure.id, failure])));
}
const fileNames = [...new Set([...fileSets.get('node20').keys(), ...fileSets.get('node22').keys()])].sort();
jsonl(join(outputDir, 'files.jsonl'), fileNames.map((file) => ({
  file,
  node20: fileSets.get('node20').get(file) ?? null,
  node22: fileSets.get('node22').get(file) ?? null,
})));
const left = failureSets.get('node20');
const right = failureSets.get('node22');
summary.comparisons.onlyNode20 = [...left].filter(([key]) => !right.has(key)).map(([, value]) => value);
summary.comparisons.onlyNode22 = [...right].filter(([key]) => !left.has(key)).map(([, value]) => value);
summary.comparisons.sameTestDifferentSignature = [...left].filter(([key, value]) => right.has(key) && right.get(key).signature !== value.signature)
  .map(([key, value]) => ({ file: value.file, test: value.test, node20: value.signature, node22: right.get(key).signature }));
json(join(outputDir, 'comparison.json'), summary.comparisons);
console.log(JSON.stringify({ sha: run.sha, status: Object.fromEntries(Object.entries(summary.status).map(([label, item]) => [label, item.status])), onlyNode20: summary.comparisons.onlyNode20.length, onlyNode22: summary.comparisons.onlyNode22.length, sameTestDifferentSignature: summary.comparisons.sameTestDifferentSignature.length }));
```
