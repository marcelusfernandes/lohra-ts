# Sondas transitórias de #841

Script executado em `F:/lohra-m25-841/probes.ps1`, reproduzido abaixo com o caminho pessoal do worktree convertido no parâmetro `$Worktree`. Requer clones Node 20/22 já instalados, o wrapper isolado `run.ps1` e os três arquivos candidatos no SHA `ece3f06`. Cada variante altera apenas uma cópia descartável, executa um caso filtrado e restaura o arquivo em `finally`. A confirmação independente procurou **ambos** os sentinels nas seis combinações assertion+cleanup. `exit 1` é esperado; `residual=0` é obrigatório.

```powershell
param([ValidateSet('20','22')][string]$Version, [string]$Worktree)
$ErrorActionPreference='Stop'
$base='F:\lohra-m25-841'
$cases=@(
  @{family='session-tools'; file='tests/session-tools.test.ts'; pattern='wires run_workflow'; assert='    const { tools } = setup();'; prefix='lohra-session-tools-'},
  @{family='workflow-templates'; file='tests/workflow-templates.test.ts'; pattern='lists through the composed registry'; assert='    const tools = setupComposedTools(home);'; prefix='lohra-templates-composed-list-'},
  @{family='gateway-compaction'; file='tests/gateway-compaction.test.ts'; pattern='stays submittable across a compaction'; assert='    const { registry, sessions } = setup();'; prefix='lohra-gateway-compaction-'}
)
function ReplaceFirst([string]$s,[string]$needle,[string]$replacement){
  $i=$s.IndexOf($needle,[StringComparison]::Ordinal)
  if($i -lt 0){throw "probe anchor missing: $needle"}
  return $s.Substring(0,$i)+$replacement+$s.Substring($i+$needle.Length)
}
foreach($c in $cases){
  $source=Join-Path $Worktree $c.file
  $target=Join-Path (Join-Path $base ('node'+$Version)) $c.file
  $original=[IO.File]::ReadAllText($source)
  foreach($variant in @('setup','assertion','cleanup','assertion-cleanup')){
    $text=$original
    if($variant -eq 'setup'){$text=ReplaceFirst $text '  connections.push(connection);' '  connections.push(connection); throw new Error("SETUP_SENTINEL");'}
    if($variant -in @('assertion','assertion-cleanup')){$text=ReplaceFirst $text $c.assert ($c.assert+' throw new Error("ASSERTION_SENTINEL");')}
    if($variant -in @('cleanup','assertion-cleanup')){$text=ReplaceFirst $text '      connection.close();' '      connection.close(); throw new Error("CLEANUP_SENTINEL");'}
    $label='probe-'+$c.family+'-'+$variant
    [IO.File]::WriteAllText($target,$text)
    try {
      & (Join-Path $base 'run.ps1') -Version $Version -Label $label -NpmArgs @('run','test','--','--maxWorkers=1',$c.file,('--testNamePattern='+$c.pattern))
      $status=$LASTEXITCODE
      $temp=Join-Path $base ('isolation-'+$Version+'-'+$label+'\temp')
      $residual=@(Get-ChildItem -LiteralPath $temp -Directory -Filter ($c.prefix+'*') -ErrorAction SilentlyContinue).Count
      $log=Join-Path $base ($label+'-'+$Version+'.log')
      $body=[IO.File]::ReadAllText($log)
      $expected=if($variant -eq 'setup'){'SETUP_SENTINEL'}elseif($variant -eq 'assertion'){'ASSERTION_SENTINEL'}elseif($variant -eq 'cleanup'){'CLEANUP_SENTINEL'}else{'ASSERTION_SENTINEL|CLEANUP_SENTINEL'}
      $hasExpected=$body -match $expected
      $hasEbusy=$body -match 'EBUSY'
      "$Version`t$($c.family)`t$variant`t$status`t$residual`t$hasExpected`t$hasEbusy" | Tee-Object -FilePath (Join-Path $base 'probe-results.tsv') -Append
    } finally { [IO.File]::WriteAllText($target,$original) }
  }
}

```

Resultados (colunas: ABI, família, variante, exit, raízes residuais, sentinel presente, EBUSY presente):

```text
22	session-tools	setup	1	0	True	False
22	session-tools	assertion	1	0	True	False
22	session-tools	cleanup	1	0	True	False
22	session-tools	assertion-cleanup	1	0	True	False
22	workflow-templates	setup	1	0	True	False
22	workflow-templates	assertion	1	0	True	False
22	workflow-templates	cleanup	1	0	True	False
22	workflow-templates	assertion-cleanup	1	0	True	False
22	gateway-compaction	setup	1	0	True	False
22	gateway-compaction	assertion	1	0	True	False
22	gateway-compaction	cleanup	1	0	True	False
22	gateway-compaction	assertion-cleanup	1	0	True	False
20	session-tools	setup	1	0	True	False
20	session-tools	assertion	1	0	True	False
20	session-tools	cleanup	1	0	True	False
20	session-tools	assertion-cleanup	1	0	True	False
20	workflow-templates	setup	1	0	True	False
20	workflow-templates	assertion	1	0	True	False
20	workflow-templates	cleanup	1	0	True	False
20	workflow-templates	assertion-cleanup	1	0	True	False
20	gateway-compaction	setup	1	0	True	False
20	gateway-compaction	assertion	1	0	True	False
20	gateway-compaction	cleanup	1	0	True	False
20	gateway-compaction	assertion-cleanup	1	0	True	False
```

## Wrapper isolado usado nas sondas

O caminho `$base` e os executáveis Node/npm podem ser adaptados ao host. A função só opera nos clones descartáveis e homes em `F:`.

```powershell
param(
  [Parameter(Mandatory = $true)][ValidateSet('20', '22')][string]$Version,
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs
)

$ErrorActionPreference = 'Stop'
$base = 'F:\lohra-m25-841'
$cwd = Join-Path $base ('node' + $Version)
$isolation = Join-Path $base ('isolation-' + $Version + '-' + $Label)
foreach ($name in @('home', 'lohra', 'codex', 'cache', 'prefix', 'temp')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $isolation $name) | Out-Null
}
$env:HOME = Join-Path $isolation 'home'
$env:USERPROFILE = $env:HOME
$env:LOHRA_HOME = Join-Path $isolation 'lohra'
$env:CODEX_HOME = Join-Path $isolation 'codex'
$env:npm_config_cache = Join-Path $isolation 'cache'
$env:npm_config_prefix = Join-Path $isolation 'prefix'
$env:TEMP = Join-Path $isolation 'temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:LEFTHOOK = '0'
if ($Version -eq '20') {
  $node = 'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node.exe'
  $npm = 'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node_modules\npm\bin\npm-cli.js'
} else {
  $node = 'C:\Program Files\nodejs\node.exe'
  $npm = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
}
$env:PATH = (Split-Path $node) + ';' + $env:PATH
Push-Location $cwd
try {
  & $node $npm @NpmArgs *> (Join-Path $base ($Label + '-' + $Version + '.log'))
  $result = $LASTEXITCODE
  Write-Output "$Label`t$Version`t$result"
  exit $result
} finally {
  Pop-Location
}





```
