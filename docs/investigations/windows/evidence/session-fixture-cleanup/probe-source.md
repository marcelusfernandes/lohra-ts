# Sondas reproduzíveis da fixture #806

A partir de um clone descartável da branch em F: com `npm ci` próprio,
execute `./run-probe.ps1 -Version 20 -Case setup`, `assertion` e `cleanup`;
repita com `-Version 22`. O script gera uma cópia temporária do próprio
`tests/gateway/session-service.test.ts`, injeta só a falha indicada e roda o
primeiro caso com Vitest. Ele move a cópia gerada para F: após cada execução;
o arquivo versionado não é alterado. Os relatórios JSON e logs ficam em F:.
A saída esperada para cada sonda é exit 1 do teste, sentinel presente e zero
resíduo no diretório temporário exclusivo.

```powershell
param([ValidateSet('20','22')][string]$Version,[ValidateSet('setup','assertion','cleanup')][string]$Case)
$ErrorActionPreference='Stop';$base='F:\lohra-m25-806';$clone=if($Version -eq '20'){"$base\node20"}else{"$base\node22-ready"};$runtime=if($Version -eq '20'){'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64'}else{'C:\Program Files\nodejs'};$node=Join-Path $runtime 'node.exe'
$source=Join-Path $clone 'tests\gateway\session-service.test.ts';$target=Join-Path $clone 'tests\gateway\session-service-probe.test.ts';$archive=Join-Path $base "probe-source-$Version-$Case.ts";$report=Join-Path $base "probe-$Version-$Case.json";$log=Join-Path $base "probe-$Version-$Case.log";$probeTemp=Join-Path $base "probe-temp-$Version-$Case"
New-Item -ItemType Directory -Force -Path $probeTemp | Out-Null
$content=[System.IO.File]::ReadAllText($source)
$setupNeedle='  fixture.connection = connection;';$assertNeedle='    const result = registry.createOrResurrect({ model: "m", systemPrompt: "sp", cwd: "/tmp" });'
if(-not $content.Contains($setupNeedle) -or -not $content.Contains($assertNeedle)){throw 'probe anchors missing'}
if($Case -eq 'setup'){$content=$content.Replace($setupNeedle,"$setupNeedle`n  throw new Error('SETUP_SENTINEL_806');")}
if($Case -eq 'assertion'){$content=$content.Replace($assertNeedle,"    throw new Error('ASSERTION_SENTINEL_806');`n$assertNeedle")}
if($Case -eq 'cleanup'){$content=$content.Replace($setupNeedle,"  fixture.connection = { ...connection, close() { connection.close(); throw new Error('CLEANUP_SENTINEL_806'); } };");$content=$content.Replace($assertNeedle,"    throw new Error('ASSERTION_SENTINEL_806');`n$assertNeedle")}
[System.IO.File]::WriteAllText($target,$content)
$env:HOME=Join-Path $base "isolation-$Version\home";$env:USERPROFILE=$env:HOME;$env:LOHRA_HOME=Join-Path $base "isolation-$Version\lohra";$env:CODEX_HOME=Join-Path $base "isolation-$Version\codex";$env:TEMP=$probeTemp;$env:TMP=$probeTemp;$env:TMPDIR=$probeTemp;$env:PATH="$runtime;$env:PATH"
Push-Location $clone
try {& $node '.\node_modules\vitest\vitest.mjs' run 'tests/gateway/session-service-probe.test.ts' -t 'creates a fresh session' --maxWorkers=1 --reporter=json "--outputFile=$report" *> $log;$code=$LASTEXITCODE}finally{Pop-Location;Move-Item -LiteralPath $target -Destination $archive}
$left=@(Get-ChildItem -LiteralPath $probeTemp -Force);"node=$Version case=$Case exit=$code residual=$($left.Count) report=$report";if($left.Count -gt 0){$left | Select-Object Name,Length};exit 0
```
