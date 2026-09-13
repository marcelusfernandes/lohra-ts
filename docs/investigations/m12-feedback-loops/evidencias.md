# Revalidação de E1–E3 no HEAD

Anexo de [`../m12-feedback-loops.md`](../m12-feedback-loops.md) (issue #574).

- **HEAD:** `a8b2fb1c1a60cb982e39964f1ec45709f61281d3`, 2026-09-13.
- **Base da captura da issue:** `1cdff10d7ac08fa684e1b2bc9ef85abcb1507e5c`.
- **Máquina:** macOS (darwin), Node 20.x via `dist/` buildado neste worktree
  (`npm run build` antes de tudo; todo comando `lohra` abaixo é
  `node dist/cli.js` **deste** worktree, nunca o shim do checkout principal).
- **Sanitização:** caminhos de `$HOME` viram `<HOME>`, diretórios temporários
  viram `<TMP>`, `session_id` vira `<redacted>`. `run_id`/`sub_id` são UUIDs
  locais e ficam, porque são o que torna os comandos de leitura reproduzíveis.
  Nenhum arquivo aqui contém chave, token ou caminho de `~/.lohra/**`.

## 1. O que mudou no código desde o SHA da captura

```sh
git log --oneline 1cdff10d..HEAD -- src/transports/errors.ts \
  src/workflow/route-faults.ts src/workflow/engine-utils.ts src/orchestration/
```

Sete commits no intervalo tocam esses caminhos (57 commits no total do
intervalo). O diff de `src/transports/errors.ts` entre os dois SHAs muda
**apenas** um comentário de `rethrowAborted` e o corpo de
`anthropicPartialUsage` (issue #567). **`classifyProviderError` e
`looksLikeModelNotFound` estão byte-idênticos ao SHA da captura.**

Referências da issue × HEAD (movimento de linha, nenhuma mudança de
comportamento):

| Referência na issue (`1cdff10d`)                               | No HEAD (`a8b2fb1c`)                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `classifyProviderError`, `errors.ts:229`                       | `src/transports/errors.ts:248`                                                                        |
| `nonCompleteFirstCollectResult`, `engine-utils.ts:205`         | `src/workflow/engine-utils.ts:205` (mesma linha)                                                      |
| `RouteLesson`, `route-faults.ts:56`                            | `src/workflow/route-faults.ts:64-86` (`RouteLesson`, `routeLesson`, `routeFaultNotice`)               |
| `subagent-prompt.ts:25`                                        | `src/orchestration/subagent-prompt.ts:10` (`SUBAGENT_ISOLATION`), `:26` (`buildSubagentSystemPrompt`) |
| `core.ts:63` (config de spawn)                                 | `src/orchestration/core.ts:63-82` (`SpawnConfig.wrapDispatch`)                                        |
| `stateful.ts:21` (memória)                                     | `src/tools/stateful.ts:21` (`MemoryTool`, mesma linha)                                                |
| `transport-error-kinds.test.ts:127` (400 genérico → `unknown`) | `tests/transport-error-kinds.test.ts:128`                                                             |

## 2. E1 — tentativa ao vivo

### 2.1 Estado do ambiente

```sh
node dist/cli.js doctor --json
```

`environment.usable: true`, mas:

- `auth_route: "api_key"`, `base_subscription_active: false`,
  `subscription_active: false`;
- `detected_provider: "anthropic"`, `provider_origin: "api-key"`;
- provedores configurados: `anthropic`, `openrouter`.

A captura original de E1 rodou com **assinatura Codex/ChatGPT**
(`auth: subscription`, modelo `gpt-6-astra`). Esse é o único contexto em que
o provedor produz o corpo `"… is not supported when using Codex with a
ChatGPT account."` — ele **nomeia a conta**, não o modelo. Habilitar
assinatura nesta máquina é gate humano (segredos/auth, ADR 0004 item 9).

**Conclusão: E1 não foi revalidado ao vivo na rota original.** Não foi
inventado nenhum substituto para esse fato.

### 2.2 Tentativa 1 — a rota que a issue prescreve (sem `--provider`)

```sh
node dist/cli.js chat --json "<spec de E1 + instruções de uma tentativa só>"
```

- exit code **2**; `error: "no provider configured — run \`lohra init\` (or \`lohra doctor\`); details on stderr"`;
- `tool_calls: []`, `api_calls: 0`, `completed: false`; nenhum run criado.
- Evidência: `e1-a8b2fb1c/e1-sem-provider.envelope.json`,
  `e1-a8b2fb1c/e1-sem-provider.stderr.txt`.

**Causa (inferido):** `runChat` (`src/commands/chat.ts:146-149`) roteia
**toda** invocação sem `--provider` que não esteja em modo `subscription`
direto para `runChatBoundary`, que devolve "no provider configured"
independentemente de haver chave em `~/.lohra/.env`. Não é falta de
credencial: é o caminho de decisão de rota. Registrado como questão aberta
(nota principal § 8.4), fora do escopo desta issue.

### 2.3 Tentativa 2 — uma execução ao vivo na rota disponível

Exatamente **uma** tentativa, mesma spec, mesmo prompt, sem trocar o modelo
inválido e sem retomar o run:

```sh
node dist/cli.js chat --provider anthropic --json "<mesmo prompt>"
```

- exit code **0**; `error: null`; `completed: true`; `api_calls: 4`;
- `tool_calls`: `run_workflow` → `workflow_status` → `workflow_notices` (três,
  na ordem pedida; o modelo não trocou o modelo do nó nem retomou o run);
- resultado do workflow filho: `status: "paused"`,
  `pause_reason: "route_fault"`, `fault_kinds: []`,
  `checkpoint: {error_kind: "model_not_found", node_id: "probe", provider:
"anthropic", model: "lohra-m12-modelo-inexistente", suggested_route: null}`,
  `faults: ["route fault 'probe' (model_not_found)"]`;
- `workflow_notices` devolveu **um** aviso `kind: "model_not_found"` escopado
  a `run:c0db747dcb8f46c0ae8052dc5e49ad74`.
- Evidência: `e1-a8b2fb1c/e1b-rota-anthropic.envelope.json`.

**Isto é evidência nova, não revalidação de E1.** A Anthropic responde a um
modelo inexistente com 404 + `model` na mensagem, forma que
`looksLikeModelNotFound` reconhece; o Codex respondeu 400 + `detail`, forma
que ele não reconhece. O contraste é o achado: **o caminho de pausa, lição e
aviso durável funciona ao vivo hoje** — o que falha em E1 é a classificação
do sinal, não o tratamento dele.

### 2.4 Leitura independente, em outro processo

```sh
node dist/cli.js workflow audit c0db747dcb8f46c0ae8052dc5e49ad74
node dist/cli.js workflow notices c0db747dcb8f46c0ae8052dc5e49ad74 --all --json
```

Os dois com exit 0. A auditoria (`e1-a8b2fb1c/e1b-workflow-audit.json`) traz
11 eventos, incluindo `leaf.failed` com `error_kind: "model_not_found"` e
`usage_uncertain: true`, `node.paused` com `reason: "route_fault"` e
`workflow.done` com `status: "paused"`; `integrity.refused_writes: 0`.

**Detalhe relevante para a nota principal § 2.3:** o evento `workflow.fault`
traz `content: {state: "excluded_by_policy", characters: 37}` — a política
`metadata_only` do ledger **não copia** o texto da falha. O texto causal vive
em `faults[]` do resultado do run e no `pause_payload_json`, não na
auditoria. É política declarada (`policy.mode: "metadata_only"`,
`policy.raw_payloads: "redacted_or_excluded_at_ingest_and_read"`), não perda
acidental.

O `workflow notices … --all --json` num processo separado devolveu o mesmo
aviso, com `acked_at: null` (nunca reconhecido) e `refused_writes: 0`.

### 2.5 Sonda determinística do classificador

Como E1 não pôde ser revalidado ao vivo, a forma do erro foi exercitada
diretamente contra o `classifyProviderError` do `dist/` buildado do HEAD.
Saída completa em `e1-a8b2fb1c/classificador-sonda.json`.

| Caso                                           | `statusCode` | `message`                    | `payload`                                                 | `kind`            |
| ---------------------------------------------- | ------------ | ---------------------------- | --------------------------------------------------------- | ----------------- |
| E1, como o transporte monta                    | 400          | `HTTP 400`                   | `{detail: "… model is not supported when using Codex …"}` | `unknown`         |
| mesmo corpo, status trocado para 404           | 404          | `HTTP 404`                   | idem                                                      | **`unknown`**     |
| mesmo corpo, `detail` também na `message`, 404 | 404          | o texto do `detail`          | idem                                                      | `model_not_found` |
| mesmo corpo, `detail` também na `message`, 400 | 400          | o texto do `detail`          | idem                                                      | **`unknown`**     |
| 400 com `error.code: model_not_found`          | 400          | —                            | `{error:{code:"model_not_found"}}`                        | **`unknown`**     |
| 404 na forma OpenAI                            | 404          | `The model x does not exist` | `{error:{code,type}}`                                     | `model_not_found` |
| 400 malformado (contraprova)                   | 400          | `Invalid schema for tool`    | `{error:{type:"invalid_request_error",param:"tools[0]"}}` | `unknown`         |

As linhas 2 e 4 são o achado: **os dois portões são independentes** e nenhum
deles sozinho resolve E1. Ver `taxonomia.md` § 2.

Por que `message` é `"HTTP 400"` e não o texto do corpo: `providerFailure`
(`src/transports/client.ts:298-315`) só promove `payload.error.message` a
`message`; um corpo com `detail` de topo cai no fallback
`` `HTTP ${status}` ``. O mesmo `providerFailure` serve os três clientes —
`ChatCompletionsClient` (`:462`), `providerPost` usado por
`AnthropicMessagesClient` e por `ResponsesClient` (`:495`, `:684`) —, então a
rota real de E1 (Codex/Responses) monta o erro exatamente assim.

## 3. E2 — os seis controles determinísticos

O script da issue foi salvo fora da árvore versionada (diretório temporário
da sessão, **não** commitado) e executado contra o `dist/` deste worktree:

```sh
npm run build
LOHRA_M12_PACKAGE_ROOT=$PWD node repro-m12.mjs
```

**exit 0, todas as asserções do script passando.** Saída sanitizada em
`e2-a8b2fb1c/`.

| #   | Controle                                   | Baseline da issue                                              | HEAD `a8b2fb1c`                                                                                         | Diverge? |
| --- | ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Mesmo corpo HTTP 400 de E1                 | `failed`, `unknown`, zero avisos                               | `failed`, `fault_kinds: ["unknown"]`, `notices: []`                                                     | não      |
| 2   | HTTP 404 com `model_not_found`             | `paused / route_fault`, lição com nó/provedor/modelo, um aviso | `paused`, `pause_reason: route_fault`, lição `{model_not_found, probe, openai, m12-404, null}`, 1 aviso | não      |
| 3   | Novo run, mesma rota inválida              | outra chamada, nova pausa, segundo aviso                       | 2 chamadas ao provedor com `m12-404`, segundo run `paused`, aviso `id: 2`                               | não      |
| 4   | Ack em outro processo                      | 2 antes; 1 visível depois; 2 com `--all`                       | `{before: 2, visibleAfter: 1, allAfter: 2}`                                                             | não      |
| 5   | Retomar o run 404 com outra rota           | `complete`                                                     | `complete`, `pivots: [{model: "m12-good", channel: "operator"}]`                                        | não      |
| 6   | Tarefa diz "leia somente A"; modelo pede B | leitura de B aceita, `complete`, `error_kind: null`            | `status: "complete"`, `error_kind: null`, `summary` contém `M12_TASK_B_OUTSIDE_ASSIGNED_TASK`           | não      |

`memoryFilesCreated: false` — nenhum `MEMORY.md` foi criado. Ver a ressalva
da nota principal § 2.5: isso descreve o caminho mecânico exercitado, não a
capacidade de um orquestrador real.

**O que E2 não mede** (repetido aqui porque a tabela acima convida ao
contrário): não mede frequência (a repetição do controle 3 foi pedida ao
simulador), não mede desvio espontâneo de um LLM (controle 6: a "decisão" do
filho é uma resposta programada), não mede fuga do sandbox de workflow, e não
mede acesso fora da pasta do projeto.

**Arquivo omitido de propósito:** `requests.json` (~42 KB) — carrega o system
prompt completo de cada requisição e não acrescenta nenhum fato às tabelas
acima; a contagem de requisições que interessa já está em `summary.json`
(`rejectedRequests400: 1`, `rejectedRequests404: 2`).

## 4. E3 — validação existente

```sh
npx vitest run tests/transport-error-kinds.test.ts \
  tests/workflow-route-faults.test.ts \
  tests/state-notices-repository.test.ts
```

```text
Test Files  3 passed (3)
Tests       69 passed (69)
```

Idêntico ao baseline da issue. O teste do 400 genérico → `unknown` continua
existindo (`tests/transport-error-kinds.test.ts:128`): é a **contraprova** que
qualquer conserto da classificação precisa preservar.

Suíte completa e mutation testing continuam fora deste diagnóstico, como no
baseline.

## 5. Achado novo: `acked_at` de um aviso reconhecido lê `0`

Não estava no baseline da issue (que nunca afirmou nada sobre o timestamp do
ack). Observado em E2 (**simulado**), com causa localizada no código
(**inferido**):

- Em `e2-a8b2fb1c/notices-all-after-ack.json` e em
  `e2-a8b2fb1c/resume-good.json` (tool `workflow_notices`), o aviso `id: 1`
  volta com `acked_by: "cli"` **e** `acked_at: 0`. Os dois canais concordam —
  não é divergência entre views.
- `acked_by` não-nulo prova que o `UPDATE` rodou: `ack()` grava os dois campos
  no mesmo statement (`src/state/notices-repository.ts:272`), com
  `now = Date.now() / 1_000` (`:269`), um valor fracionário.
- A coluna é `acked_at REAL` (`src/state/schema.ts:120`), e o leitor usa
  `nullableRowNumber` → `rowNumber`, que devolve `0` para qualquer número que
  não seja `Number.isSafeInteger` (`src/state/notices-repository.ts:91-101`).
  `created_at` é lido com `Number(row.created_at)` direto (`:131`) e por isso
  não sofre o mesmo.

Nada foi corrigido aqui: esta entrega é classe docs e não toca `src/`.
Encaminhamento proposto em `epicos-propostos.md` § 2.

## 6. #426 e #440 — como foram usados

Nenhum dos dois é tratado como prova do comportamento atual; os dois são
**contexto de decisão**, e o comportamento atual veio das execuções acima.

- **#426** (M10-S5) decidiu que `auth_failed`/`route_fault`/`model_not_found`
  pausam o run com lição estruturada. A decisão datada
  (`docs/decisions/2026-09-12-pausa-por-recusa-de-rota.md`) descreve o
  mecanismo; E1b e E2 controle 2 **mostram** esse mecanismo funcionando no
  HEAD. A pergunta de M12 não é se #426 funciona — é por que o sinal de E1
  não chega até ele.
- **#440** (com a decisão de 2026-09-13,
  `docs/decisions/2026-09-13-flags-de-rota-com-assinatura.md`) tratou um
  caminho **diferente**: `--provider`/`--model` explícitos no `chat` com
  assinatura ativa, que viravam um 400 do Codex; a correção é recusar a flag
  antes de qualquer I/O. E1 **não** passa por esse caminho: o chat de E1 não
  usou `--provider`, e o modelo recusado estava no nó do workflow, resolvido
  pelo engine. A coincidência é o corpo do 400 — a causa e o ponto de
  correção são outros.

Também considerado sem ser tratado como prova: as notas de 2026-09-13 sobre
envelope de rotas e canal `route_envelope` (M11), que explicam por que
`suggested_route` pode deixar de ser `null` — conhecimento **declarado pelo
operador**, nunca aprendido de um incidente.

## 7. Índice dos arquivos de evidência

| Arquivo                                                           | Conteúdo                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `e1-a8b2fb1c/e1-sem-provider.envelope.json`                       | Envelope da tentativa na rota que a issue prescreve (exit 2, `api_calls: 0`). |
| `e1-a8b2fb1c/e1-sem-provider.stderr.txt`                          | stderr da mesma tentativa.                                                    |
| `e1-a8b2fb1c/e1b-rota-anthropic.envelope.json`                    | Envelope da única execução ao vivo (exit 0, 3 tool calls, run pausado).       |
| `e1-a8b2fb1c/e1b-workflow-audit.json`                             | `lohra workflow audit RUN_ID` em processo separado.                           |
| `e1-a8b2fb1c/e1b-workflow-notices-all.json`                       | `lohra workflow notices RUN_ID --all --json` em processo separado.            |
| `e1-a8b2fb1c/classificador-sonda.json`                            | Sete corpos de erro contra `classifyProviderError` do `dist/` do HEAD.        |
| `e2-a8b2fb1c/summary.json`                                        | Resumo dos seis controles.                                                    |
| `e2-a8b2fb1c/http400.json`, `http404.json`, `http404-repeat.json` | Envelopes dos controles 1-3, com `meta.json` (exit code, duração, argv).      |
| `e2-a8b2fb1c/notices-*.json`, `notice-ack.json`                   | Controle 4 (ack cross-process).                                               |
| `e2-a8b2fb1c/resume-good.json`                                    | Controle 5 (retomada com outra rota).                                         |
| `e2-a8b2fb1c/task-scope.json`                                     | Controle 6 (escopo de tarefa).                                                |
