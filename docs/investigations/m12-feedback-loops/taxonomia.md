# Taxonomia de sinais e escopo de tarefa

Anexo de [`../m12-feedback-loops.md`](../m12-feedback-loops.md) (issue #574).
HEAD `a8b2fb1c`. **Tudo marcado como "proposta" é proposta**; os fatos trazem
`arquivo:linha` ou apontam para um arquivo de evidência.

## 1. O que já existe (fato)

### 1.1 O vocabulário

`ERROR_KINDS` é fechado, com 10 valores (`src/transports/error-kinds.ts`):
`quota_exhausted`, `auth_failed`, `model_not_found`, `route_fault`,
`sandbox_denied`, `timeout`, `cancelled`, `context_length`, `unknown`,
`dead_turn`. `NOTICE_KINDS` estende com quatro de estado
(`stale_fence_write`, `audit_sink_failure`, `resume_attempts_exhausted`,
`queue_overflow`, `src/state/notices-repository.ts:18-25`).

`unknown` **não é silêncio**: nomeia um `ProviderCallFailed` sem mapeamento
fino, e o comentário do próprio arquivo diz isso. Um erro que não é de
provedor continua `null`, e o resto da cadeia trata `null` como "não é falha
de provedor".

### 1.2 Os três destinos de um sinal hoje

Dado o `ErrorKind` de uma folha, `nonCompleteFirstCollectResult`
(`src/workflow/engine-utils.ts:205`) escolhe um de três caminhos:

| Kind                                                             | Destino                          | Efeito                                                                                                                                        |
| ---------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `quota_exhausted`                                                | `noteQuotaExhausted`             | pausa o run; não conta em `fault_kinds`                                                                                                       |
| `auth_failed`, `route_fault`, `model_not_found` (`isRouteFault`) | `noteRouteFault` + `routeLesson` | pausa o run com `pause_reason: route_fault`, lição estruturada, **e um aviso durável** (`recordRouteFaultNotice`); não conta em `fault_kinds` |
| qualquer outro, inclusive `unknown`                              | `recordFault`                    | entra em `faults[]` com o texto causal truncado em 200 chars; conta em `fault_kinds`; o run segue                                             |

A exclusão de `fault_kinds` para os dois primeiros é deliberada
(`pausesRun`, `src/workflow/route-faults.ts`): a folha vai ser re-executada
no resume e contá-la agora dobraria depois.

### 1.3 Quando cabe cada coisa (doutrina vigente, fato)

- **Aviso ao operador**: quando alguém precisa agir e o run não pode
  continuar sozinho — hoje, exatamente os três kinds de rota, mais os quatro
  kinds de estado que o `NoticesSink` já escreve.
- **Lição estruturada**: quando existe uma ação corretiva nomeável
  (`{error_kind, node_id, provider, model, suggested_route}`) — hoje só para
  rota.
- **Só fault/auditoria**: todo o resto. É o destino de `unknown`, e é onde E1
  cai.

## 2. Por que o 400 de E1 não chega ao caminho de rota

**Dois portões independentes**, ambos verificados na sonda
(`e1-a8b2fb1c/classificador-sonda.json`):

### Portão A — o status

`classifyProviderError` (`src/transports/errors.ts:248`) só consulta o indício
de modelo depois de `value.statusCode === 404`. Um 400 nunca chega lá, por
mais que o corpo cite o modelo. **Prova:** o caso "mesmo corpo, `detail`
também na `message`, 400" → `unknown`; o mesmo com 404 → `model_not_found`.

### Portão B — a forma do corpo

`looksLikeModelNotFound` (`src/transports/errors.ts:238-245`) examina quatro
lugares: `value.code`, `payload.error.code`, `payload.error.type` e
`value.message`. **Nunca** um campo de topo do payload. O corpo de E1
(`{"detail": "…"}`) não tem nenhum dos quatro, e `providerFailure`
(`src/transports/client.ts:298-315`) só promove `payload.error.message` a
`message` — sem ele, `message` vira o literal `` `HTTP ${status}` ``. **Prova:**
o caso "mesmo corpo, status trocado para 404" → **`unknown`**.

**Consequência para quem for consertar:** uma correção que relaxe só o portão
A não resolve E1. É preciso mexer nos dois, ou em nenhum dos dois e sim em
`providerFailure` (que teria de promover um texto de corpo desconhecido a
`message`) **junto com** o portão A.

O mesmo `providerFailure` serve os três clientes (`ChatCompletionsClient`
`:462`; `providerPost` `:495`, usado por `AnthropicMessagesClient` e por
`ResponsesClient` `:684`), então a rota real de E1 (Codex/Responses) monta o
erro exatamente assim — a sonda é fiel ao caminho de produção.

## 3. Discriminar um 400 de modelo recusado de um 400 malformado (proposta)

O "Fora de escopo" da issue é explícito: **generalizar todo HTTP 400 como
falha de rota está proibido**, e com razão — a contraprova já existe na suíte
(`tests/transport-error-kinds.test.ts:128`, 400 genérico → `unknown`) e na
sonda (400 malformado com `invalid_request_error` + `param` → `unknown`).

Três discriminadores **candidatos**, do mais específico para o mais frouxo.
Nenhum é recomendado aqui como decisão; a escolha pertence à issue de
conserto.

| #   | Regra candidata                                                                                     | Casa com E1?       | Recusa o 400 malformado?                            | Risco                                                                        |
| --- | --------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| D1  | O corpo cita **verbatim o modelo pedido** (comparação com `routing.model`)                          | sim                | sim — um erro de schema não repete o slug do modelo | precisa que o classificador conheça o modelo pedido, que hoje ele não recebe |
| D2  | Um campo **string de topo** do payload (ex.: `detail`) casa `/model/iu`, **e** não há `error.param` | sim                | sim, no caso conhecido                              | `/model/iu` é frouxo: "the model's output was rejected" casaria              |
| D3  | Estender `looksLikeModelNotFound` a qualquer string do payload, mantendo o portão A em 404          | **não** (E1 é 400) | trivialmente                                        | não resolve E1; listado só para descartar explicitamente                     |

**Observação que separa D1 das outras:** o corpo de E1 diz "not supported
**when using Codex with a ChatGPT account**". A condição é da **rota de
autenticação**, não do modelo. Um classificador que responda
`model_not_found` a esse corpo está tecnicamente certo sobre "esta rota
recusou este modelo" e **errado** sobre "este modelo não existe" — a
diferença importa no momento em que alguém quiser reutilizar a observação
(nota principal § 3, Abordagem B). Duas saídas possíveis, ambas propostas:

- **(i)** classificar como `model_not_found` e acrescentar o eixo
  `auth_route` à `RouteLesson`, de modo que a lição diga em que rota a recusa
  aconteceu; ou
- **(ii)** reconhecer que o vocabulário fechado não tem um valor para "esta
  conta não pode usar este modelo" e decidir, explicitamente, se isso é um
  11º kind ou um caso de `model_not_found` com proveniência melhor.

A investigação **não escolhe** entre (i) e (ii): é decisão de design com
custo de migração (o vocabulário é fechado e aparece em `NOTICE_KINDS`, na
auditoria e no rollup durável).

### Contraprovas obrigatórias para qualquer regra escolhida

1. 400 genérico sem indício de modelo → `unknown`
   (o teste em `tests/transport-error-kinds.test.ts:128` já fixa isso).
2. 400 malformado com `error.type: "invalid_request_error"` e `error.param`
   → `unknown`.
3. 404 na forma OpenAI → `model_not_found` (não-regressão).
4. O corpo de E1 → o kind que a decisão escolher, **e** a lição carregando o
   suficiente para não generalizar fora da rota de autenticação.

## 4. Escopo de tarefa: restrição mecânica × desvio semântico

### 4.1 Os dois caminhos de filho (fato)

`SpawnConfig.wrapDispatch` (`src/orchestration/core.ts:63-82`) é opt-in por
folha: `OrchestrationChildRuntime.spawn` o preenche com o sandbox instalado
pela aquisição da **folha durável de workflow**; `delegate_task` e
`spawn_session` (`src/orchestration/tools.ts`) **não** o setam. Os dois
caminhos compartilham só a deny-list de `createChildDispatch`
(`src/tools/child.ts:62-68`), que exclui 24 ferramentas
(`CHILD_EXCLUDED_TOOLS`, `src/tools/child.ts:5-30`) —
`delegate_task`, `memory`, `skill_view`, `session_search`, `run_workflow`,
`workflow_status`, `workflow_notices`, `workflow_notices_ack`,
`list_models`, entre outras. **`read_file` não está na lista.**

Por isso o controle 6 de E2 se comporta como se comporta: o filho de
`delegate_task` tinha `read_file` disponível e nenhuma restrição por tarefa.

### 4.2 As duas coisas que "escopo" pode significar (proposta de recorte)

|                          | **Restrição mecânica**                                                                                     | **Desvio semântico**                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| O que é                  | "este filho só pode tocar estes arquivos / chamar estas ferramentas"                                       | "este filho fez algo diferente do objetivo da tarefa" |
| Verificável?             | Sim, por construção: a recusa é um `sandbox_denied` observável                                             | Não mecanicamente: exige julgar intenção              |
| Existe hoje?             | **Parcialmente** — sim para folha de workflow (policy `fs_allow`/`egress_allow`), não para `delegate_task` | Não                                                   |
| Contraprova possível?    | Sim (§ 4.3)                                                                                                | Não com as superfícies atuais                         |
| Candidato a épico agora? | Sim                                                                                                        | **Não** — sem forma de aceitação, vira debate         |

### 4.3 Contraprova "A permitido / B fora" (proposta de primeiro experimento)

A contraprova mais barata **não precisa de contrato novo**: usa a policy que
M8/M10 já entregaram.

1. `workflow_policy.json` com `fs_allow` cobrindo **só** `task-a.txt`.
2. Um run de workflow com uma folha cuja tarefa é "leia somente `task-a.txt`".
3. Duas execuções, com o mesmo simulador determinístico do script de E2:
   - **A permitido** — a folha lê `task-a.txt`: esperado `complete`, sem
     `sandbox_refusals`;
   - **B fora** — a folha tenta `task-b.txt`: esperado `sandbox_denied`, com
     `sandbox_refusals` ≥ 1 no rollup do run.
4. Repetir os mesmos dois casos pelo caminho `delegate_task`: esperado que
   **os dois passem** — a diferença entre os dois caminhos é o achado, e é ela
   que define se o épico de escopo é "estender o sandbox existente a
   `delegate_task`" ou "criar um contrato por tarefa".

O resultado esperado está declarado **antes** da execução de propósito: se B
não for negado na folha de workflow, a premissa de que a restrição mecânica
já existe naquele caminho está errada, e o épico muda de forma.

### 4.4 O que a sonda de E2 não autoriza a concluir

Repetido aqui porque é o erro mais fácil de cometer ao ler a tabela de
controles: o controle 6 **não** mede taxa de desvio de um LLM (a decisão do
filho foi programada), **não** prova falha do sandbox de workflow (ele não
estava no caminho testado) e **não** mede acesso fora da pasta do projeto (os
dois arquivos estavam na mesma pasta).

## 5. O que atravessa a delegação hoje (fato, com consequência proposta)

| Item                      | Atravessa? | Onde se lê                                                      |
| ------------------------- | ---------- | --------------------------------------------------------------- |
| Texto da tarefa           | **sim**    | argumento de `delegate_task`                                    |
| Prompt do pai / histórico | não        | `SUBAGENT_ISOLATION`, `src/orchestration/subagent-prompt.ts:10` |
| Memória (`MEMORY.md`)     | não        | `memory` em `CHILD_EXCLUDED_TOOLS` (`src/tools/child.ts:7`)     |
| Skills                    | não        | `skill_view`/`skill_manage` excluídos                           |
| Avisos do operador        | não        | `workflow_notices`/`workflow_notices_ack` excluídos             |
| Lição de rota             | não        | o filho nem enxerga `run_workflow`/`workflow_status`            |

**Consequência (proposta):** uma lição só pode alcançar um filho por duas
rotas compatíveis com o invariante 1 (prompt congelado por sessão,
`src/conversation/runtime.ts:177-178`): **pelo texto da tarefa**, ou por um
**campo novo e explícito de `SpawnConfig`** consumido na montagem do primeiro
turno. Nenhuma proposta desta investigação pede reconstrução do prompt vivo,
e qualquer proposta futura que peça deve ser recusada por esse motivo.

Um corolário que merece registro: abrir `workflow_notices` ao filho seria a
alternativa "simples", e é justamente a que **não** se recomenda sem medida —
ela transforma a deny-list (hoje uma fronteira legível de uma linha) numa
política condicional, e dá ao filho leitura de todos os escopos, não só do
run dele (`src/tools/builtin-definitions.ts:636-641`).
