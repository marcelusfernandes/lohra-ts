# Reprodução de #829

Os logs desta medição permanecem em `F:\lohra-m25-829`. Os comandos abaixo exigem o checkout da branch `test/829-windows-durable-fixture-home`, Git, Node 20.20.2 portátil, Node 22.23.3, Docker e as dependências do lockfile. Use clones e homes próprios; nenhum comando consulta o home pessoal. `core.protectNTFS=false` é somente o contorno conhecido para clonar este repositório em NTFS; não altera o checkout principal.

## Windows

```powershell
$base = 'F:\lohra-m25-829'
git -c core.protectNTFS=false clone --no-hardlinks --branch test/829-windows-durable-fixture-home C:\Users\marce\Desktop\repositories\lohra-test-829 "$base\node20"
git -c core.protectNTFS=false clone --no-hardlinks --branch test/829-windows-durable-fixture-home C:\Users\marce\Desktop\repositories\lohra-test-829 "$base\node22"
git -C "$base\node20" switch --detach 603c31ec26edfd84fd25a0fdef8d4419a8dd51c7
git -C "$base\node22" switch --detach 603c31ec26edfd84fd25a0fdef8d4419a8dd51c7
& "$base\run.ps1" -Version 20 -Label npm-ci ci
& "$base\run.ps1" -Version 22 -Label npm-ci ci
# Para o vermelho, usar a base 603c31e, antes da mudança nos dois arquivos.
& "$base\run.ps1" -Version 20 -Label baseline test -- --maxWorkers=1 tests/workflow-durable-chat.test.ts tests/workflow-durable-dashboard.test.ts
& "$base\run.ps1" -Version 22 -Label baseline test -- --maxWorkers=1 tests/workflow-durable-chat.test.ts tests/workflow-durable-dashboard.test.ts
# Para o verde, trazer somente os dois testes e a declaração de prova do head 9b8b6d3.
foreach ($v in @('20','22')) {
  Copy-Item tests\workflow-durable-chat.test.ts "$base\node$v\tests\workflow-durable-chat.test.ts"
  Copy-Item tests\workflow-durable-dashboard.test.ts "$base\node$v\tests\workflow-durable-dashboard.test.ts"
  Copy-Item prova\windows-durable-fixture-home.ts "$base\node$v\prova\windows-durable-fixture-home.ts"
  foreach ($step in @('build','typecheck','lint','format:check')) {
    $label = if ($step -eq 'format:check') { 'format' } else { $step }
    & "$base\run.ps1" -Version $v -Label $label run $step
  }
  & "$base\run.ps1" -Version $v -Label proof run prova -- windows-durable-fixture-home
}
```

`run.ps1` completo usado na medição:

```powershell
param(
  [Parameter(Mandatory = $true)][ValidateSet('20', '22')][string]$Version,
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs
)
$ErrorActionPreference = 'Stop'
$base = 'F:\lohra-m25-829'
$cwd = Join-Path $base ('node' + $Version)
$isolation = Join-Path $base ('isolation-' + $Version)
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

## Linux

Bundle da branch foi clonado em `/work/lohra829`, HEAD verificado como `9b8b6d34d8614789fc960d094117144096852a50`. Esta fonte contém a correção do argumento `--branch`; na execução inicial somente esse argumento estava errado. O controle negativo foi repetido isoladamente com o argumento correto e guardado como `negative.log`.

```sh
#!/bin/sh
set -eu
cd /work/lohra829
mkdir -p /tmp/lohra829-evidence /tmp/lohra829-isolation/home /tmp/lohra829-isolation/lohra /tmp/lohra829-isolation/codex /tmp/lohra829-isolation/cache /tmp/lohra829-isolation/prefix /tmp/lohra829-isolation/temp
export HOME=/tmp/lohra829-isolation/home USERPROFILE=/tmp/lohra829-isolation/home LOHRA_HOME=/tmp/lohra829-isolation/lohra CODEX_HOME=/tmp/lohra829-isolation/codex
export npm_config_cache=/tmp/lohra829-isolation/cache npm_config_prefix=/tmp/lohra829-isolation/prefix TMPDIR=/tmp/lohra829-isolation/temp TMP=/tmp/lohra829-isolation/temp TEMP=/tmp/lohra829-isolation/temp
run() {
  name="$1"; shift
  printf '%s start\n' "$name"
  set +e
  "$@" > "/tmp/lohra829-evidence/$name.log" 2>&1
  code="$?"
  set -e
  printf '%s\t%s\n' "$name" "$code" | tee -a /tmp/lohra829-evidence/results.tsv
  if [ "$code" -ne 0 ]; then tail -n 25 "/tmp/lohra829-evidence/$name.log"; exit "$code"; fi
}
git rev-parse HEAD > /tmp/lohra829-evidence/head.txt
run npm-ci npm ci
run build npm run build
run typecheck npm run typecheck
run lint npm run lint
run format npm run format:check
run test npm test -- --maxWorkers=1
run prova npm run prova -- windows-durable-fixture-home
run negative npm run ci:controle-negativo -- --base 603c31ec26edfd84fd25a0fdef8d4419a8dd51c7 --head 9b8b6d34d8614789fc960d094117144096852a50 --branch test/829-windows-durable-fixture-home
git status --short > /tmp/lohra829-evidence/status.txt
```
