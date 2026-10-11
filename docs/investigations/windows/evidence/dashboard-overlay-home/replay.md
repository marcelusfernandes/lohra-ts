# Replay de #828

Executar em clones descartáveis, com Node 20.20.2 e Node 22.23.3 e seus `npm ci` separados; o checkout principal não participa. `core.protectNTFS=false` contorna apenas o nome `aux.ts` no clone NTFS e não altera o Git principal. Os caminhos abaixo são os da medição e podem ser substituídos por diretórios temporários equivalentes.

```powershell
$base = 'F:\lohra-m25-828'
git -c core.protectNTFS=false clone --no-hardlinks --branch test/828-windows-dashboard-overlay-home C:\Users\marce\Desktop\repositories\lohra-test-828 "$base\node20"
git -c core.protectNTFS=false clone --no-hardlinks --branch test/828-windows-dashboard-overlay-home C:\Users\marce\Desktop\repositories\lohra-test-828 "$base\node22"
git -C "$base\node20" switch --detach dce780c1d1c96ddc9ec6c91e47922e3b6eeb5b06
git -C "$base\node22" switch --detach dce780c1d1c96ddc9ec6c91e47922e3b6eeb5b06
foreach ($v in @('20','22')) {
  & "$base\run.ps1" -Version $v -Label npm-ci ci
  & "$base\run.ps1" -Version $v -Label baseline test -- --maxWorkers=1 tests/gateway/dashboard-ws-overlay.test.ts
  Copy-Item tests\gateway\dashboard-ws-overlay.test.ts "$base\node$v\tests\gateway\dashboard-ws-overlay.test.ts"
  Copy-Item prova\windows-dashboard-overlay-home.ts "$base\node$v\prova\windows-dashboard-overlay-home.ts"
  & "$base\run.ps1" -Version $v -Label focal-green test -- --maxWorkers=1 tests/gateway/dashboard-ws-overlay.test.ts
  foreach ($step in @('build','typecheck','lint','format:check')) {
    $label = if ($step -eq 'format:check') { 'format' } else { $step }
    & "$base\run.ps1" -Version $v -Label $label run $step
  }
  & "$base\run.ps1" -Version $v -Label proof run prova -- windows-dashboard-overlay-home
}
```

Sonda causal executada antes de copiar os arquivos candidatos, em cada clone e ABI:

```powershell
$code = "import {resolvePaths} from './src/config/paths.ts'; import {join,relative} from 'node:path'; const root='F:/probe-root'; const env={HOME:root,PATH:''}; const seed=join(root,'.lohra'); const actual=resolvePaths(env).home; process.stdout.write(JSON.stringify({platform:process.platform,seed:relative(root,seed),runtime:relative(root,actual),same:seed===actual})+'\n');"
Push-Location 'F:\lohra-m25-828\node20'
try { & 'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node.exe' --import tsx --input-type=module -e $code } finally { Pop-Location }
Push-Location 'F:\lohra-m25-828\node22'
try { & 'C:\Program Files\nodejs\node.exe' --import tsx --input-type=module -e $code } finally { Pop-Location }
```

Para verificar o candidato, acrescente `LOHRA_HOME:seed` a `env` na sonda; ambas produziram `same:true`. A sonda não lê nem escreve o banco e usa um root sintético.

Fonte integral de `F:\lohra-m25-828\run.ps1`:

```powershell
param(
  [Parameter(Mandatory = $true)][ValidateSet('20', '22')][string]$Version,
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs
)

$ErrorActionPreference = 'Stop'
$base = 'F:\lohra-m25-828'
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

Linux: criar bundle da branch no SHA e39845f2ad051359128fc7ef9e1e32d3d4280d56, clonar em `/work/lohra828` como usuário `node` e rodar a fonte abaixo. O controle negativo test-only é `SKIP` esperado; não prova sozinho a correção, cujo vermelho nativo e verde estão acima.

```sh
#!/bin/sh
set -eu
cd /work/lohra828
mkdir -p /tmp/lohra828-evidence /tmp/lohra828-isolation/home /tmp/lohra828-isolation/lohra /tmp/lohra828-isolation/codex /tmp/lohra828-isolation/cache /tmp/lohra828-isolation/prefix /tmp/lohra828-isolation/temp
export HOME=/tmp/lohra828-isolation/home USERPROFILE=/tmp/lohra828-isolation/home LOHRA_HOME=/tmp/lohra828-isolation/lohra CODEX_HOME=/tmp/lohra828-isolation/codex
export npm_config_cache=/tmp/lohra828-isolation/cache npm_config_prefix=/tmp/lohra828-isolation/prefix TMPDIR=/tmp/lohra828-isolation/temp TMP=/tmp/lohra828-isolation/temp TEMP=/tmp/lohra828-isolation/temp
run() {
  name="$1"; shift
  printf '%s start\n' "$name"
  set +e
  "$@" > "/tmp/lohra828-evidence/$name.log" 2>&1
  code="$?"
  set -e
  printf '%s\t%s\n' "$name" "$code" | tee -a /tmp/lohra828-evidence/results.tsv
  if [ "$code" -ne 0 ]; then tail -n 25 "/tmp/lohra828-evidence/$name.log"; exit "$code"; fi
}
git rev-parse HEAD > /tmp/lohra828-evidence/head.txt
run npm-ci npm ci
run build npm run build
run typecheck npm run typecheck
run lint npm run lint
run format npm run format:check
run test npm test -- --maxWorkers=1
run prova npm run prova -- windows-dashboard-overlay-home
run negative npm run ci:controle-negativo -- --base dce780c1d1c96ddc9ec6c91e47922e3b6eeb5b06 --head e39845f2ad051359128fc7ef9e1e32d3d4280d56 --branch test/828-windows-dashboard-overlay-home
git status --short > /tmp/lohra828-evidence/status.txt

```
