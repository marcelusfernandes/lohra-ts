# Replay de #835

Os clones do vermelho começam no SHA `ceaf81e492e3baffe0dea9eb05d1b8a66d9c8cbd` e têm `npm ci` próprio. O overlay do verde copia só `tests/workflow-live-tail.test.ts`, `tests/workflow-notices-sink.test.ts` e `prova/windows-live-notices-fixture-home.ts` do código `82b7ee1`; os hashes SHA-256 dos três arquivos foram comparados com o worktree e iguais nas duas ABIs:

| Arquivo                                      | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `tests/workflow-live-tail.test.ts`           | `16ADFEDDE6978BAF5701C4CC61B113120858B7897470C5F4973CC9578CD7B549` |
| `tests/workflow-notices-sink.test.ts`        | `0ECB7311E4B6389772782829BA28E8AEEF076ED720004A8D66C89B23DD0E8B03` |
| `prova/windows-live-notices-fixture-home.ts` | `D12D4BA2B08CD57A3B05B7AC58611BAE8E74FA550D58BB75DD8946666604F88C` |

O wrapper completo está em `F:/lohra-m25-835/run.ps1` (SHA-256 `3DA22B8EAA901374DFA0E0004DAF859B9C3EC235C24CD1BBA9A48B519EF82116`). A fonte essencial de execução é:

```powershell
$base = 'F:/lohra-m25-835'
$version = '20' # repetir com '22', usando seu próprio clone e dependências
$clone = Join-Path $base ('node' + $version)
$iso = Join-Path $base ('isolation-' + $version)
foreach ($name in 'home','lohra','codex','cache','prefix','temp') {
  New-Item -ItemType Directory -Force -Path (Join-Path $iso $name) | Out-Null
}
$env:HOME = Join-Path $iso 'home'
$env:USERPROFILE = $env:HOME
$env:LOHRA_HOME = Join-Path $iso 'lohra'
$env:CODEX_HOME = Join-Path $iso 'codex'
$env:npm_config_cache = Join-Path $iso 'cache'
$env:npm_config_prefix = Join-Path $iso 'prefix'
$env:TEMP = Join-Path $iso 'temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$node = if ($version -eq '20') {
  'F:/lohra-m25-761-runtime/node-v20.20.2-win-x64/node.exe'
} else { 'C:/Program Files/nodejs/node.exe' }
$npm = if ($version -eq '20') {
  'F:/lohra-m25-761-runtime/node-v20.20.2-win-x64/node_modules/npm/bin/npm-cli.js'
} else { 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' }
$env:PATH = (Split-Path $node) + ';' + $env:PATH
Push-Location $clone
try {
  & $node $npm ci
  & $node $npm test -- --maxWorkers=1 tests/workflow-live-tail.test.ts tests/workflow-notices-sink.test.ts
  & $node $npm run build
  & $node $npm run typecheck
  & $node $npm run lint
  & $node $npm run format:check
  & $node $npm run prova -- windows-live-notices-fixture-home
} finally { Pop-Location }
```

Executar o foco antes e depois do overlay. Cada wrapper real grava um log por etapa e preserva o exit code; os `baseline-{20,22}.log` retêm IDs e erros completos. Comparar a lista de diretórios `lohra-t369-*` e `lohra-t401-*` do TEMP antes/depois do verde para distinguir resíduos do vermelho de novos resíduos. Não reutilizar `node_modules` entre ABIs nem tocar dados do operador.

No Linux, o candidato foi clonado do bundle `F:/lohra-m25-835/code-82b7ee1.bundle` (SHA-256 `C897C45B0CE9CBDB8F471550A096114EC40E4436CB0337379D5F5A8630E7C2FC`) em `/work/lohra835`. O script abaixo é `F:/lohra-m25-835/linux-run.sh` (SHA-256 `AF3F1D4446883B9A3C6BCA278D03A023BBC5841E7EDA5D885B4BE6F03A5E6B09`), executado como usuário `node` com ambiente/temporários próprios. A saída por etapa fica em `/tmp/lohra835-evidence` e é copiada para `F:` após a medição.

```sh
#!/bin/sh
set -eu
cd /work/lohra835
mkdir -p /tmp/lohra835-evidence /tmp/lohra835-isolation/home /tmp/lohra835-isolation/lohra /tmp/lohra835-isolation/codex /tmp/lohra835-isolation/cache /tmp/lohra835-isolation/prefix /tmp/lohra835-isolation/temp
export HOME=/tmp/lohra835-isolation/home USERPROFILE=/tmp/lohra835-isolation/home LOHRA_HOME=/tmp/lohra835-isolation/lohra CODEX_HOME=/tmp/lohra835-isolation/codex
export npm_config_cache=/tmp/lohra835-isolation/cache npm_config_prefix=/tmp/lohra835-isolation/prefix TMPDIR=/tmp/lohra835-isolation/temp TMP=/tmp/lohra835-isolation/temp TEMP=/tmp/lohra835-isolation/temp
run() {
  name="$1"; shift
  printf '%s start\n' "$name"
  set +e
  "$@" > "/tmp/lohra835-evidence/$name.log" 2>&1
  code="$?"
  set -e
  printf '%s\t%s\n' "$name" "$code" | tee -a /tmp/lohra835-evidence/results.tsv
  if [ "$code" -ne 0 ]; then tail -n 25 "/tmp/lohra835-evidence/$name.log"; exit "$code"; fi
}
git rev-parse HEAD > /tmp/lohra835-evidence/head.txt
run npm-ci npm ci
run build npm run build
run typecheck npm run typecheck
run lint npm run lint
run format npm run format:check
run test npm test -- --maxWorkers=1
run prova npm run prova -- windows-live-notices-fixture-home
run negative npm run ci:controle-negativo -- --base ceaf81e492e3baffe0dea9eb05d1b8a66d9c8cbd --head 82b7ee1d9767b4f53f1fd8c219452db199a25f8f --branch test/835-windows-live-notices-fixture-home
git status --short > /tmp/lohra835-evidence/status.txt
```
