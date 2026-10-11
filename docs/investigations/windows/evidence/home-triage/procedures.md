# Reprodução controlada de #729

Ambiente medido: Windows 11 Pro 10.0.26200.0 x64; Node 20.20.2 e 22.23.2. Árvores `fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1` e `3b25a36c9aef520d06ad90aa3da8bd4ae09fbbb1`. Cada versão de Node teve `npm ci` e módulos nativos próprios em clone descartável F:. `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, cache e prefix npm foram diretórios vazios próprios em F:. Nenhum segredo, home pessoal ou provedor remoto entrou nos testes: a fixture usa servidor HTTP em `127.0.0.1` (`tests/chat-compaction-events.test.ts:37-61,91-115`).

No PowerShell, para cada clone descartável:

```powershell
$repo = 'F:\<clone-descartavel>'
$isolated = 'F:\<ambiente-isolado>'
$node = 'F:\<node20>\node.exe' # ou Node 22.23.2 com ABI própria
foreach ($part in 'home','lohra','codex','temp','cache','prefix') {
  New-Item -ItemType Directory -Force -Path (Join-Path $isolated $part) | Out-Null
}
$env:HOME = Join-Path $isolated 'home'
$env:USERPROFILE = $env:HOME
$env:LOHRA_HOME = Join-Path $isolated 'lohra'
$env:CODEX_HOME = Join-Path $isolated 'codex'
$env:TEMP = Join-Path $isolated 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $isolated 'cache'
$env:npm_config_prefix = Join-Path $isolated 'prefix'
Push-Location $repo
& $node .\node_modules\vitest\vitest.mjs run tests/chat-compaction-events.test.ts --reporter=verbose --maxWorkers=1
$testExit = $LASTEXITCODE
Pop-Location
```

O `LOHRA_HOME` externo acima isola o processo. A chamada direta a `runChat` no teste recebe **outro objeto** `environment`, contendo apenas `HOME: root` (mais `PATH`/`LOHRA_CONTEXT_WINDOW`). Por isso o ambiente externo não conserta a divergência interna da fixture. O corpus original falhou 5/5 e saiu 1 nos quatro pares SHA/Node da [matriz](matrix.json). Dois casos retomados retornaram `code=1`, com `stderr` `session not found: <id>` ([excertos sanitizados](errors.json) de logging temporário no clone); os três casos de título lançaram `ENOENT` no `lstat` de `<TEMP>/.lohra`, seguidos por `EBUSY` no cleanup de `<TEMP>/lohra/state.db`.

Em **outro clone descartável**, aplicar somente [fixture-alignment.patch](fixture-alignment.patch) aos cinco `environment` do corpus e repetir o comando: 5/5 PASS, exit 0, nos dois Nodes e dois SHAs. A intervenção não toca `src/` e preserva as asserções. A patch foi capturada no SHA `3b25a36`; as mesmas cinco inserções foram aplicadas manualmente no clone histórico porque o contexto do teste mudou entre SHAs. O SHA histórico contém `src/agent/aux.ts`, nome reservado pelo Windows; checkout daquele commit precisou de `git -c core.protectNTFS=false`, sem alteração global.

Sonda mínima, com [fonte integral](home-probe-source.mts) (SHA-256 `4BE064F47801D8BE964B32D23B419B48A18DDEDA704FE0BD20237769911788BE`):

```powershell
$env:PROBE_REPO = $repo
$env:PROBE_SHA = (git -C $repo rev-parse --short HEAD)
& $node (Join-Path $repo 'node_modules\tsx\dist\cli.mjs') '<checkout-docs-729>\docs\investigations\windows\evidence\home-triage\home-probe-source.mts'
$probeExit = $LASTEXITCODE
```

A sonda cria um `root` em `TEMP`, calcula `resolvePaths({HOME: root})`, abre e fecha `state.db` pela API real, registra se cada diretório existe, faz `lstatSync` no `home` explícito e chama `createOutputPlan`. Repete com `{HOME: root, LOHRA_HOME: join(root, '.lohra')}`. Os quatro [JSONs](probe-current-node20.json) registram exit 0, `resolvedHome=lohra`/`.lohra`, momento de criação, `ENOENT` no primeiro `lstat`/plano e sucesso no segundo. Paths saem relativos ao root; a sonda remove o root após fechar as conexões. Logs integrais brutos ficaram em F: local, pois incluem nomes aleatórios de TEMP; a matriz e os JSONs preservam os resultados sanitizados.

Esta investigação não rodou a suíte Windows inteira e não atribui os demais `ENOENT`/`EBUSY` de W2/W4 à mesma causa. O smoke de compactação com stub já havia passado em W4 (`runtime.md:18`), mas não substitui o corpus que falha aqui. Prova da issue #729: N/A documental; #789 contém o gate executável para corrigir a fixture.
