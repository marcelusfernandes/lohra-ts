# Reprodução de #730

Fonte: commit de produto `4f709668db1d841555929a1023bb3a4d99ea6314`, Windows 11 x64 build 26200, Node 20.20.2 / 22.23.2. Os logs ao lado são as medições reais; este roteiro usa `<TEMP>` como diretório próprio do executor e não lê o home pessoal. Cada Node precisa de checkout/build e `npm ci` próprios para a ABI de `node-pty`. Em nossa execução, os clones de produto usaram dependências ABI-compatíveis já instaladas em clones temporários separados; `npm run build` retornou 0 em ambos. O SHA do lock é `A7E0DE3A40F4B19435114F3FB23AC674802BDC93055ABC921249617659A6CC01`.

Execute em PowerShell, substituindo somente os três caminhos iniciais:

```powershell
$node = '<NODE20-ou-NODE22>\node.exe'
$checkout = '<TEMP>\checkout-do-commit-4f70966'
$scenarioDir = '<TEMP>\shutdown-node20-ou-node22'
New-Item -ItemType Directory -Force -Path $scenarioDir, "$scenarioDir\home", "$scenarioDir\codex", "$scenarioDir\temp", "$scenarioDir\cache", "$scenarioDir\prefix" | Out-Null
$env:HOME = "$scenarioDir\home"
$env:USERPROFILE = "$scenarioDir\home"
$env:LOHRA_HOME = "$scenarioDir\home"
$env:CODEX_HOME = "$scenarioDir\codex"
$env:TEMP = "$scenarioDir\temp"
$env:TMP = "$scenarioDir\temp"
$env:npm_config_cache = "$scenarioDir\cache"
$env:npm_config_prefix = "$scenarioDir\prefix"
$env:PROBE_NODE = $node
$env:PROBE_REPO = $checkout
$env:PROBE_SHA = '4f70966'
$env:PROBE_NODE_PTY = Join-Path $checkout 'node_modules\node-pty'
$env:PROBE_WS = Join-Path $checkout 'node_modules\ws'
$probeDir = Join-Path $checkout 'docs\investigations\windows\evidence\shutdown-validation'
$env:PROBE_MARKER = Join-Path $scenarioDir 'sigint-marker.txt'
& $node (Join-Path $probeDir 'signal-probe.cjs')
$LASTEXITCODE
foreach ($command in @('serve','dashboard')) {
  foreach ($mechanism in @('ctrlc','sigterm')) {
    $env:PROBE_COMMAND = $command
    $env:PROBE_MECHANISM = $mechanism
    & $node (Join-Path $probeDir 'server-probe.cjs')
    $LASTEXITCODE
  }
}
& $node (Join-Path $probeDir 'ws-shutdown-probe.cjs')
$LASTEXITCODE
```

Para preparar o checkout, `git clone`/`git switch --detach 4f70966` em diretório temporário próprio, `npm ci` usando o `npm-cli.js` do mesmo Node, e `npm run build` devem terminar 0; não reutilize binários `node-pty` entre Node 20 e 22. Isolar também `APPDATA`/`LOCALAPPDATA` da instalação se necessário. A sonda de servidor cria seus próprios homes por processo, porta dinâmica e stub loopback; ela não requer credenciais nem chamadas de modelo. `--insecure` é usado só em `127.0.0.1` para medir o shutdown sem token real.

`server-probe.cjs` retorna exit 0 quando registra o resultado esperado do respectivo mecanismo; no controle `sigterm`, o **filho** sai `exitCode=null,signal=SIGTERM`. `ws-shutdown-probe.cjs` também retorna 0 ao registrar a falha conhecida: `exitWhileWsOpen=null`, seguida de saída 0 só depois de `ws.close()`; isso não significa que o produto passou no caso WS. Os timeouts da fonte limitam os experimentos; somente filhos criados pela sonda são encerrados. O campo `pid=0` do `ws` é uma peculiaridade do objeto `node-pty` nesse harness e não foi usado para inferir identidade/processo. `signal-probe.cjs` grava `SIGINT_HANDLER` dentro de um Node filho, provando entrega de Ctrl-C em ConPTY; não atribui esse marcador ao CLI.
