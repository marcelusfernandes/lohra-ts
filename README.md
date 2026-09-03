# lohra-ts

Runtime TypeScript headless do Lohra, com CLI, gateway/dashboard, workflows
duráveis, cron, MCP, ferramentas web e mídia. A versão atual é `0.0.11`.

O port foi validado contra o runtime Python pinado. O pacote de produção não
embute nem chama Python, pip, uv ou poetry; Python existe somente nos harnesses
de paridade do repositório de desenvolvimento.

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
- A matriz nativa Windows e Node 20/22 precisa ser executada em runners reais;
  spoof de plataforma não conta como evidência.

## Paridade e closeout

O oracle Python de referência é lido no SHA
`16b4785d803ad0ca364a8a67346a04f949fbf592`; ele nunca é modificado por este
repo. Evidence fica em `.parity-evidence/` (gitignored).

```bash
LOHRA_ORACLE_WORKSPACE=/caminho/para/o/worktree-python npm run parity:closeout
npm run mutations:closeout
npm run verify:t22:evidence
```

O aggregate compara um inventário fechado nos dois sentidos, executa cada
suíte não-live duas vezes e recusa scripts ausentes, órfãos, skips, resultados
não determinísticos ou mutantes sobreviventes. O relatório completo dos 23
tickets, SHAs e dívidas está em [docs/closeout.md](docs/closeout.md).

## Decisão arquitetural

O owner escolheu `typescript-mainline` para o novo capítulo. A decisão, seus
limites e a estratégia de preservação do arquivo local protegido estão em
[docs/gate-decision-t22.md](docs/gate-decision-t22.md). O runtime Python segue
somente como oracle semântico read-only; nenhuma implementação é feita nele.
