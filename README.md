# lohra-ts

[![ci](https://github.com/marcelusfernandes/lohra-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/marcelusfernandes/lohra-ts/actions/workflows/ci.yml)

Runtime TypeScript headless do Lohra, com CLI, gateway/dashboard, workflows
duráveis, cron, MCP, ferramentas web e mídia. A versão atual é `0.0.11`.

O runtime nasceu como port validado contra o runtime Python pinado até
2026-09-04; desde essa data, por decisão do owner, evolui de forma
independente do Python ([ADR 0003](docs/adr/0003-native-wire-format.md)). O
pacote de produção não
embute nem chama Python, pip, uv ou poetry; o Python aparece apenas no
histórico de paridade do repositório de desenvolvimento.

## Instalação

Requer Node.js 20 ou 22 e npm. O terminal local usa o addon nativo `node-pty`,
portanto a instalação executa o `postinstall` do pacote.

```bash
npm install -g lohra-ts@0.0.11
lohra --version
lohra doctor --json
```

Para desenvolver a partir do checkout:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm run format:check
```

Em sessões de Claude Code, `.claude/settings.json` formata e aplica `eslint --fix` em cada
arquivo editado (hook `PostToolUse`) e libera sem prompt os comandos read-only acima; o gate
continua sendo `npm run lint` + `npm run format:check`.

## CLI

Os comandos top-level públicos, na ordem exibida pelo help, são:

`init`, `doctor`, `chat`, `dashboard`, `serve`, `cron`, `workflow`, `models`,
`tiers`, `profile`, `auth`, `skill` e `update`.

Exemplos:

```bash
lohra chat "Resuma este projeto" --json
lohra dashboard --insecure --port 8000
lohra cron list
lohra workflow list
lohra workflow watch RUN_ID
lohra workflow audit RUN_ID
lohra update --check
```

`workflow` possui somente `list`, `watch` e `audit`; não existe
`workflow run`. Chat e dashboard compartilham a mesma composition root para
workflow/audit, orquestração, cron, MCP, web e mídia.

## Self-update

Em um checkout Git, `lohra update --check` faz fetch e mede o upstream sem
mover `HEAD`. `lohra update` recusa árvore suja, detached HEAD, upstream ausente
e divergência; quando permitido, usa apenas fast-forward. Mudanças em manifests
de dependências produzem uma recomendação de `npm install`; `--reinstall`
executa npm por executable/argv, sem shell.

Uma instalação por tarball/npm não contém `.git`, então o updater recusa com a
orientação de atualizar pelo npm.

## Limites e superfícies não medidas

- Budgets, fan-out, filas de audit e retenção são limitados e falham de forma
  explícita.
- Estado cross-process usa SQLite/WAL com lease e fencing.
- URLs web passam por proteção SSRF, resolução pinada e revalidação por hop.
- Subsessões de orquestração não podem ser promovidas a sessões privilegiadas
  do gateway.
- Registro e refresh MCP são transacionais por lote.
- Smokes de providers/SDKs reais permanecem `NOT_MEASURED` sem credenciais; os
  gates normais são offline e usam fixtures locais.
- O CI (`.github/workflows/ci.yml`) mede `ubuntu-latest` × Node 20/22 (Linux
  x64): build, typecheck, lint, format:check e test em todo push na `main` e
  toda PR, mais o job `provenance` que exige que cada SHA aprovado em
  `docs/closeout.md` seja ancestral do HEAD. Windows nativo e macOS Node 20
  permanecem `NOT_MEASURED`; spoof de plataforma não conta como evidência.

## Histórico de paridade

Até 2026-09-04 o runtime era desenvolvido como port validado bilateralmente
contra o oracle Python pinado no SHA
`16b4785d803ad0ca364a8a67346a04f949fbf592`
([ADR 0003](docs/adr/0003-native-wire-format.md)). O aggregate de closeout
comparava um inventário fechado nos dois sentidos, executava cada suíte
não-live duas vezes e recusava scripts ausentes, órfãos, skips, resultados não
determinísticos ou mutantes sobreviventes; evidence ficava em
`.parity-evidence/` (gitignored). Desde essa data a validação contra o Python
deixou de ser critério de aceite: as fixtures capturadas na fase de paridade
são hoje o corpus de regressão do runtime, e a migração dos scripts
`parity:*` para `regression:*` está rastreada em #8 e #19.

```bash
npm run mutations:closeout
npm run verify:t22:evidence
```

O relatório completo dos 23 tickets, SHAs e dívidas do fechamento está em
[docs/closeout.md](docs/closeout.md).

## Decisão arquitetural

O owner escolheu `typescript-mainline` para o novo capítulo em
[docs/gate-decision-t22.md](docs/gate-decision-t22.md) (2026-09-03) e, em
2026-09-04, encerrou a obrigação de paridade com o Python
([ADR 0003](docs/adr/0003-native-wire-format.md)). O runtime Python segue
somente como referência histórica; nenhuma implementação é feita nele, e
nenhuma saída deste runtime precisa reproduzir os bytes dele.
