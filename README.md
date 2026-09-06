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

`npm test` roda a suíte inteira independente de `npm run build`: nenhum arquivo de teste
importa de `dist/` (`npm ci && npm test` já passa em checkout limpo). `npm run typecheck` e
`npm run lint`, ao contrário, exigem `dist/` — alguns scripts de paridade sob `scripts/`
importam o pacote compilado de propósito (smoke tests do artefato publicado), por isso a
ordem acima mantém `npm run build` antes deles.

## Desenvolvimento

`npm run doutor` confere se esta máquina tem o que o checkout precisa — Node
≥ 20, `python3`/`make`/`g++` (só em Linux, build nativo do `node-pty`), `gh`
autenticado, e os dois hooks locais (`git-pre-push`, `pre-commit` do
lefthook) instalados. Cada falta vem com o comando que resolve; sai `1` se
sobrar alguma:

```
FALTA  gh — gh não encontrado no PATH
       resolve com: brew install gh && gh auth login
```

`npm ci`/`npm install` (`scripts/postinstall.mjs`) instalam dois hooks
nativos do git neste checkout, sempre que há um `.git` (instalação por
tarball pula os dois em silêncio):

- `git-pre-push` — camada 2 da proteção da `main` (`.claude/hooks/README.md`):
  nega push direto em `main`/`master` e qualquer push não fast-forward.
- `pre-commit` do [lefthook](https://lefthook.dev) (`lefthook.yml`):
  `prettier --check` e `eslint` nos arquivos staged (`.ts`/`.mjs`/`.js`,
  `prettier` cobre também `.md`/`.yml`/`.json`) — um commit desformatado é
  recusado antes de chegar ao CI. `lefthook install` sem argumento instala
  todos os hooks do `lefthook.yml` e faz backup dos existentes; usamos
  `install pre-commit` para que o `pre-push` nativo continue sendo o de
  `.claude/hooks/git-pre-push`.

## Prova por issue

Cada issue declara sua prova em `prova/<slug>.ts` (`<slug>` é o mesmo da branch
`<type>/<n>-<slug>`, ver `.claude/rules/git-workflow.md`):

```ts
export default { unit: ["tests/x.test.ts", "tests/y.test.ts"] } satisfies Declaracao;
```

`unit` lista os arquivos de teste que a issue cobre (caminhos relativos à
raiz; precisam existir). `check` (opcional, default `false`) também roda
`npm run typecheck` antes do vitest.

```bash
npm run prova -- <slug>
```

roda **só** os arquivos declarados (não a suíte inteira) e escreve
`.prova/<slug>/resumo.json` — `{ ok, total, falhas }`, onde `total` é o
número de testes **executados** (`passed`/`failed`; testes `skip`/`todo`
individuais não contam para `total` e não viram falha — nunca rodaram) e
cada `falhas[]` tem `{ nome, motivo }`. Três formas de falha explícita, além
de um teste reprovado: um arquivo declarado que o vitest não reportou (fora
do `include`, ou nunca alcançado) vira `"<arquivo> did not run"`; um arquivo
que rodou mas cujos testes são **todos** `skip`/`todo` (nenhum de fato
executou) vira `"<arquivo> ran zero tests"` — skip **parcial**, com pelo
menos um teste executado no arquivo, continua verde; e um processo do
vitest que sai com código diferente de zero e, mesmo assim, produziria um
relatório "ok" vira `"vitest run"` em vez de `ok:true`. Nenhuma dessas três
passa em silêncio. `vitest.json` e `resumo.json` de uma execução anterior
do mesmo slug são apagados antes de cada execução (não o diretório
`.prova/<slug>/` inteiro) — o relatório de uma corrida anterior nunca
sobrevive para ser lido como se fosse desta; ambos são gerados de novo a
cada execução e `.prova/` é ignorado por git, prettier e eslint.
`LOHRA_PROVA_OUT` redireciona a saída para `<LOHRA_PROVA_OUT>/<slug>/` em
vez de `.prova/<slug>/` (evita corrida entre execuções concorrentes do
mesmo slug) — o hook `Stop` (#46) ignora essa variável e sempre lê
`.prova/<slug>/resumo.json`, então ela serve para uma segunda execução em
paralelo fora do caminho que o hook observa, não para redirecioná-lo. Sem
`prova/<slug>.ts`, ou com um arquivo declarado inexistente, o comando sai
com `exit 1` citando o caminho.

## CI

Toda PR passa por cinco checks (`.github/workflows/ci.yml`); `main` só recebe
merge commit com todos verdes e `review:approved` (ADR 0004):

| check                | prova                                                                                                                                                                                                    | reproduzir localmente                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `checks (20)`/`(22)` | suíte inteira (antes do build, #108), depois build, typecheck, lint, format em Node 20 e 22                                                                                                              | `npm test && npm run build && npm run typecheck && npm run lint && npm run format:check` |
| `provenance`         | todo SHA aprovado em `docs/closeout.md` é ancestral do HEAD                                                                                                                                              | `npm run provenance:check`                                                               |
| `escopo`             | o diff cabe nos globs de `## Files` da issue ligada por `Closes #N` (mais `authorised:` que só o orquestrador põe)                                                                                       | `npm run ci:escopo -- --files-file f --issue-body-file i --pr-body-file p`               |
| `contratos`          | nada em `docs/reference/**`/`lohra/**`; sem import de `python-json`/`python-repr` (após #17); arquivo ≤ 800 linhas, ou já assim na base e sem crescer (#93), ou com `@generated` na primeira linha (#91) | `npm run ci:contratos -- --files-file f [--apos-17]`                                     |
| `controle-negativo`  | os testes do diff, aplicados sobre a base da PR, reprovam (`npm run prova -- <slug>` na base)                                                                                                            | `npm run ci:controle-negativo -- --base <sha> --head <sha>`                              |

Os três últimos rodam só em `pull_request` e escrevem um bloco no summary do
job. Quando reprovam:

- `escopo` lista os arquivos fora dos globs. Ou a issue passa a declarar o
  glob em `## Files`, ou o orquestrador (só ele) escreve
  `authorised: ` + glob em crase na seção `## Files` da PR. Issue anterior ao
  padrão (#44) sem `## Files` reprova toda PR com uma mensagem citando o
  número da issue: o orquestrador acrescenta a seção à issue antes de
  reivindicá-la. Uma PR sem `Closes #N` no corpo (exceções do
  `git-workflow.md` — typo, arquivo pequeno, mudança exploratória) também
  passa quando `authorised:` cobre o diff inteiro, sem precisar de issue
  linkada; `authorised:` dentro de um bloco de código (fence) nunca conta.
- `contratos` lista `regra: arquivo — motivo`; erro de uso (flag desconhecida)
  ou de infraestrutura (evento malformado, `GITHUB_STEP_SUMMARY` inválido,
  `git` ausente) sai com exit 2, nunca um exit 1 indistinguível de violação.
  `arquivo-grande` compara `linhas(head)` com `linhas(base)` (#93): arquivo
  já acima de 800 linhas na base que só é editado, sem crescer, passa; que
  cresce ou que é novo reprova, citando as duas contagens quando há base
  (`1216 → 1220 linhas (> 800; a base já tinha 1216)`). O modo dry-run
  (`--files-file`, usado no comando de reprodução local acima) não conhece a
  base do CI: trata todo arquivo como novo, fail-closed, e avisa disso no
  stderr. Arquivo com `@generated` na primeira linha fica isento do limite —
  tabela de dados gerada (`src/web/html5-entities.ts`), não código escrito à
  mão; o marcador em qualquer outro lugar do arquivo não conta (#91).
- `controle-negativo` reprova em `vacuous-pass` (o teste novo já passa na base
  sem a implementação: escreva primeiro o teste que reprova, commit
  `test(red):`), em `structural-red` sem um commit `test(red):` válido no range
  (um que toque os testes do diff e adicione um stub que lança — um stub só
  dentro de um comentário não conta), em PR de feature sem `prova/<slug>.ts`,
  e quando a base não consegue rodar a prova (`package.json` ilegível, sem
  `resumo.json`, `npm run prova` sem terminar dentro de 10 minutos). Base sem
  harness (`package.json` ausente, ou sem `scripts.prova` — o harness #42
  ainda não existia naquele commit) é PASS logado no summary, não falha.
  Fora do checkout de CI (sem `--branch`), uma branch local que não segue
  `<type>/<n>-<slug>` reprova pedindo `--slug`/`--branch` explícito. PR só de
  `docs`/`process` é SKIP; PR cujo diff (tirando `docs`/`process`) cai
  inteiro em `tests/**`/`prova/**`, com pelo menos um `tests/**` EDITADO
  (não criado), também é SKIP — o overlay reproduz o próprio HEAD
  (base+overlay ≡ head) e o mecanismo nunca discrimina vermelho de verde; o
  revisor confere o commit `test(red):` manualmente. Um `tests/**`
  inteiramente novo sem produção continua controlado normalmente.

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

### Erros e `--help`

O texto de erro e de ajuda da CLI é próprio deste produto — não é um
mimetismo do `argparse` nem de qualquer outra biblioteca, e pode mudar sem
ADR (`docs/adr/0003-native-wire-format.md`, "Human-facing text", item 5).
Exit codes, esses sim, são contrato e não mudam.

Todo uso incorreto (comando desconhecido, opção desconhecida, opção sem
valor, valor inválido) imprime duas linhas em `stderr` e sai com **exit 2**:

```
usage: lohra <comando> [options]
lohra: error: <mensagem>
```

Exemplos:

```
$ lohra nope
usage: lohra <command> [options]
lohra: error: unknown command "nope"; available commands: init, doctor, chat, dashboard, serve, cron, workflow, models, tiers, profile, auth, skill, update

$ lohra chat --model
usage: lohra chat [options]
lohra: error: option --model needs a value

$ lohra cron --interval x
usage: lohra cron [options]
lohra: error: option --interval expects an integer, got "x"
```

`lohra --help` e `lohra <comando> --help` (exit 0) listam, respectivamente,
todos os comandos e as opções/sub-ações de um comando, cada uma com uma
frase de descrição.

### Envelope `--json`

Todo comando com `--json` (`chat`, `doctor`, `models`, …) e `auth status`
(sempre JSON, sem flag própria) emitem o corpo com `JSON.stringify` nativo,
não um mimetismo de `json.dumps` (`docs/adr/0003-native-wire-format.md`,
seção "JSON output"):

- Chaves em ordem de inserção — nunca ordenadas por code point.
- Caracteres não-ASCII saem como UTF-8 literal; não há escape `\uXXXX` além
  do que o próprio `JSON.stringify` já faz para caracteres de controle.
- Compacto (separadores padrão de `JSON.stringify`) onde a saída sempre foi
  compacta; indentado com 2 espaços (`JSON.stringify(valor, null, 2)`) onde
  já era indentado antes — `chat --json`, `auth status`, o arquivo
  `auth.json`/`oauth.json` e o `jobs.json` do cron.
- `NaN`/`Infinity`/`-Infinity` nunca aparecem como literal na saída: um
  número não-finito numa fronteira de serialização é erro com causa
  (`TypeError`), não um byte silenciosamente inválido. O cron store é a
  única exceção documentada — uma agenda `once` não-finita (`nan_literal`,
  Emenda E3) continua sendo aceita e relida, mas é persistida como um
  objeto JSON-safe, nunca como o token bare `NaN`.

Qualquer consumidor que faça `JSON.parse` (em vez de comparar bytes) não é
afetado: os nomes e tipos de campo do envelope não mudaram, só a forma dos
bytes.

### Servidor (`lohra serve`)

`lohra serve` expõe uma superfície compatível com a API da OpenAI:
`GET /health`, `GET /v1/models`, `POST /v1/chat/completions`,
`POST /v1/responses` e `GET /openapi.json` (documento OpenAPI mínimo, com
`operationId` em cada rota). Rotas desconhecidas — incluindo `/docs`,
`/redoc` e `/docs/oauth2-redirect`, removidas na issue #74 — respondem 404
como qualquer outra.

Todo corpo de requisição inválido nas duas rotas `POST` responde **422** no
envelope de erro da própria API, não em um formato específico de framework
(`docs/adr/0003-native-wire-format.md`, item 6 "HTTP server"):

```json
{
  "error": {
    "message": "model: field is required",
    "type": "invalid_request_error",
    "param": "model",
    "code": "validation_error",
    "details": [{ "path": ["body", "model"], "message": "field is required" }]
  }
}
```

`message` e `param` refletem o primeiro item de `details` (`param` é o
`path` sem o prefixo `"body"`, em notação `campo[índice].subcampo`; `null`
quando a falha é do corpo inteiro). `details` é uma extensão própria deste
servidor e traz todas as falhas encontradas, cada uma com `path`, `message`
e, quando há um valor de fato recebido, `received`. Corpo ausente
(`Content-Length: 0`) responde com `details: [{"path": ["body"], "message":
"request body is required"}]`; JSON malformado responde com uma mensagem que
embute a causa: `"request body is not valid JSON: <causa>"`. As coerções
sempre aceitas por este servidor (`temperature`/`max_tokens` como string
numérica, `stream` como `"true"`/`0`/`1`/…) continuam aceitas — só a forma do
erro mudou.

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
