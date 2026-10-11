# Fonte das sondas da fixture leaf-read (#811)

Em clones ABI independentes com `npm ci` próprio, execute
`./run-probe.ps1 -Version 20 -Case setup`, `assertion` e `cleanup`; repita
com `-Version 22`. O script parte do próprio arquivo de teste da branch,
cria uma cópia temporária dentro do clone para manter os imports relativos,
injeta apenas a falha escolhida e roda o primeiro caso com Vitest. A cópia
é movida para F: ao final; o arquivo versionado não é alterado. Para cada
sonda, espera-se exit 1, a causa sentinela no JSON e zero resíduo no
`TEMP` exclusivo. A sonda cleanup fecha o DB antes de lançar sua falha,
permitindo verificar duas causas sem forçar EBUSY.

```powershell
param([ValidateSet('20','22')][string]$Version,[ValidateSet('setup','assertion','cleanup')][string]$Case)
$ErrorActionPreference='Stop';$base='F:\lohra-m25-811';$clone=Join-Path $base "node$Version";$runtime=if($Version -eq '20'){'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64'}else{'C:\Program Files\nodejs'};$node=Join-Path $runtime 'node.exe';$source=Join-Path $clone 'tests\workflow-leaf-read-tool.test.ts';$target=Join-Path $clone 'tests\workflow-leaf-read-tool-probe.test.ts';$archive=Join-Path $base "probe-source-$Version-$Case.ts";$report=Join-Path $base "probe-$Version-$Case.json";$log=Join-Path $base "probe-$Version-$Case.log";$probeTemp=Join-Path $base "probe-temp-$Version-$Case"
New-Item -ItemType Directory -Force -Path $probeTemp|Out-Null
$content=[System.IO.File]::ReadAllText($source);$setupNeedle='  fixture.connection = connection;';$assertNeedle='    plantLeaf(target, { subId: "leaf-1", parentId: "parent-1", runId: "run-1" });';if(-not $content.Contains($setupNeedle) -or -not $content.Contains($assertNeedle)){throw 'probe anchors missing'}
if($Case -eq 'setup'){$content=$content.Replace($setupNeedle,"$setupNeedle`n  throw new Error('SETUP_SENTINEL_811');")}
if($Case -eq 'assertion'){$content=$content.Replace($assertNeedle,"    throw new Error('ASSERTION_SENTINEL_811');`n$assertNeedle")}
if($Case -eq 'cleanup'){$content=$content.Replace($setupNeedle,"  fixture.connection = { ...connection, close() { connection.close(); throw new Error('CLEANUP_SENTINEL_811'); } };");$content=$content.Replace($assertNeedle,"    throw new Error('ASSERTION_SENTINEL_811');`n$assertNeedle")}
[System.IO.File]::WriteAllText($target,$content)
$env:HOME=Join-Path $base "isolation-$Version\home";$env:USERPROFILE=$env:HOME;$env:LOHRA_HOME=Join-Path $base "isolation-$Version\lohra";$env:CODEX_HOME=Join-Path $base "isolation-$Version\codex";$env:TEMP=$probeTemp;$env:TMP=$probeTemp;$env:TMPDIR=$probeTemp;$env:PATH="$runtime;$env:PATH"
Push-Location $clone
try{& $node '.\node_modules\vitest\vitest.mjs' run 'tests/workflow-leaf-read-tool-probe.test.ts' -t 'reads the turns already committed by a live leaf' --maxWorkers=1 --reporter=json "--outputFile=$report" *> $log;$code=$LASTEXITCODE}finally{Pop-Location;Move-Item -LiteralPath $target -Destination $archive}
$left=@(Get-ChildItem -LiteralPath $probeTemp -Force);"node=$Version case=$Case exit=$code residual=$($left.Count) report=$report";if($left.Count -gt 0){$left|Select-Object Name,Length};exit 0
```
