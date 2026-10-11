# Replay de #820

O foco executado nos clones descartáveis usa o SHA de base para medir o vermelho e os quatro arquivos do candidato para medir o verde. Cada versão instala dependências próprias com `npm ci`; o `node_modules` de Node 20 não é reutilizado por Node 22. O wrapper externo `F:/lohra-m25-820/run.ps1` (SHA-256 `03FA658369B65B161CB067CEA505779F98B6DBC40D9FA53C0A5B53637D77EB61`) escolhe o Node da ABI, exporta as variáveis abaixo e grava o exit code original por etapa em `F:/lohra-m25-820/<etapa>-<versao>.log`.

```powershell
$root = 'F:/lohra-m25-820'
$version = '20' # repetir com '22' em clone e instalação independentes
$clone = Join-Path $root ('node' + $version)
$iso = Join-Path $root ('isolation-' + $version)
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
  & $node $npm test -- --maxWorkers=1 tests/chat-prompt-caching.test.ts tests/chat-audit-trail-wiring.test.ts tests/chat-provider-detectado.test.ts
  & $node $npm run build
  & $node $npm run typecheck
  & $node $npm run lint
  & $node $npm run format:check
  & $node $npm run prova -- windows-chat-fixture-home
} finally { Pop-Location }
```

Para o verde, copiar **somente** os três testes e `prova/windows-chat-fixture-home.ts` do commit candidato para cada clone da base, comparar SHA-256 dos quatro arquivos, e executar os comandos acima de novo. O baseline vermelho antecede essa cópia. Não usar os resíduos de temp do baseline para inferir sucesso de limpeza: comparar os nomes antes e depois do verde. Os logs e resumos em `F:/lohra-m25-820/` distinguem os dois ensaios.

No Linux, `F:/lohra-m25-820/code-dcecae1.bundle` (SHA-256 `5D15618EF9337BE9F6E7AF0E0EE065B2431F292C93D10F87FA73657AC4DF9C46`) foi clonado em `/work/lohra820`; HEAD conferido como `dcecae1`. O script literal de execução fica em `F:/lohra-m25-820/linux-run.sh` (SHA-256 `EEFC86AD5D9965DFE576358DF81E4054A76592EB573A9010087A9702EC9B95C4`), executado como usuário `node`, com diretórios próprios em `/tmp/lohra820-isolation`, logs por etapa em `/tmp/lohra820-evidence` e `npm test -- --maxWorkers=1`. Ele chama os cinco gates, a prova e `npm run ci:controle-negativo -- --base b9832ab885dfdb4133a2ff98c6ca7a68197ef77e --head dcecae1877752e5c4129113b97441fb4aff20e47 --branch test/820-windows-chat-fixture-home`.

Fonte completa do script Linux medido:

```sh
#!/bin/sh
set -eu
cd /work/lohra820
mkdir -p /tmp/lohra820-evidence /tmp/lohra820-isolation/home /tmp/lohra820-isolation/lohra /tmp/lohra820-isolation/codex /tmp/lohra820-isolation/cache /tmp/lohra820-isolation/prefix /tmp/lohra820-isolation/temp
export HOME=/tmp/lohra820-isolation/home USERPROFILE=/tmp/lohra820-isolation/home LOHRA_HOME=/tmp/lohra820-isolation/lohra CODEX_HOME=/tmp/lohra820-isolation/codex
export npm_config_cache=/tmp/lohra820-isolation/cache npm_config_prefix=/tmp/lohra820-isolation/prefix TMPDIR=/tmp/lohra820-isolation/temp TMP=/tmp/lohra820-isolation/temp TEMP=/tmp/lohra820-isolation/temp
run() {
  name="$1"; shift
  printf '%s start\n' "$name"
  set +e
  "$@" > "/tmp/lohra820-evidence/$name.log" 2>&1
  code="$?"
  set -e
  printf '%s\t%s\n' "$name" "$code" | tee -a /tmp/lohra820-evidence/results.tsv
  if [ "$code" -ne 0 ]; then tail -n 25 "/tmp/lohra820-evidence/$name.log"; exit "$code"; fi
}
git rev-parse HEAD > /tmp/lohra820-evidence/head.txt
run npm-ci npm ci
run build npm run build
run typecheck npm run typecheck
run lint npm run lint
run format npm run format:check
run test npm test -- --maxWorkers=1
run prova npm run prova -- windows-chat-fixture-home
run negative npm run ci:controle-negativo -- --base b9832ab885dfdb4133a2ff98c6ca7a68197ef77e --head dcecae1877752e5c4129113b97441fb4aff20e47 --branch test/820-windows-chat-fixture-home
git status --short > /tmp/lohra820-evidence/status.txt
```
