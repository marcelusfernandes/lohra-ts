# M12 — Aprendizado operacional: enquadramento, abordagens e épicos propostos

- **Issue:** #574 (investigação preparatória da milestone 12).
- **Data da revalidação:** 2026-09-13.
- **HEAD revalidado:** `a8b2fb1c1a60cb982e39964f1ec45709f61281d3`.
- **SHA da captura original (issue #574):** `1cdff10d7ac08fa684e1b2bc9ef85abcb1507e5c`.
- **Natureza do documento:** investigação. **Tudo que não estiver rotulado
  como fato observado é proposta** — nenhum épico foi aberto, nenhuma decisão
  foi tomada, nenhum código foi alterado por esta entrega.

## Índice

| Anexo                                                                              | Conteúdo                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`m12-feedback-loops/evidencias.md`](m12-feedback-loops/evidencias.md)             | Revalidação de E1/E2/E3 no HEAD: comandos, exit codes, divergências, o que não foi revalidado e por quê.                                         |
| [`m12-feedback-loops/taxonomia.md`](m12-feedback-loops/taxonomia.md)               | Taxonomia de sinais, os dois portões que barram o 400 de E1, discriminador proposto, e escopo de tarefa (restrição mecânica × desvio semântico). |
| [`m12-feedback-loops/epicos-propostos.md`](m12-feedback-loops/epicos-propostos.md) | Propostas de épicos (problema, User Story, AC, dependências, fronteiras, primeiro experimento, adiados) e o experimento de uso real.             |
| `m12-feedback-loops/e1-a8b2fb1c/`                                                  | Envelopes, auditoria, avisos e sonda determinística do classificador da tentativa ao vivo.                                                       |
| `m12-feedback-loops/e2-a8b2fb1c/`                                                  | Saída sanitizada dos seis controles determinísticos.                                                                                             |

## 0. Como ler os rótulos

Cada afirmação de comportamento neste conjunto de notas carrega um destes
três rótulos, e nenhuma outra:

- **observado ao vivo** — executado contra um provedor real, nesta máquina,
  em 2026-09-13; a evidência bruta está em `e1-a8b2fb1c/`.
- **simulado** — executado com a CLI, o transporte, o SQLite e as ferramentas
  reais, mas com as decisões do modelo e as respostas HTTP programadas por um
  servidor local (`e2-a8b2fb1c/`). Mede mecânica, nunca frequência nem
  comportamento espontâneo de um LLM.
- **inferido** — lido do código no HEAD, com `arquivo:linha`, sem execução que
  o exercite de ponta a ponta nesta investigação.

## 1. Resumo da revalidação

Detalhe, comandos e arquivos em [`evidencias.md`](m12-feedback-loops/evidencias.md).

| Evidência                                                   | Rótulo hoje                                          | Resultado no HEAD                                                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1 — recusa de modelo pelo provedor real (Codex/assinatura) | **não revalidado ao vivo** na rota original          | A rota da captura (assinatura Codex) não existe neste ambiente: `doctor` reporta `auth_route: api_key`, `base_subscription_active: false`. A forma do erro foi revalidada por outros dois caminhos (abaixo). |
| E1 — o 400 de E1 classifica como `unknown`                  | **simulado** + **determinístico**                    | Reproduzido em E2 (mesmo corpo, transporte Chat Completions) e por sonda direta em `classifyProviderError` sobre o `dist/` buildado do HEAD.                                                                 |
| E1b — mesma spec numa rota disponível (Anthropic)           | **observado ao vivo** (evidência **nova**, não é E1) | `paused` / `pause_reason: route_fault`, lição estruturada e **um** aviso durável. O caminho feliz funciona ponta a ponta.                                                                                    |
| E2 — os seis controles determinísticos                      | **simulado**                                         | Os seis reproduzem o baseline da issue, asserção por asserção, exit 0.                                                                                                                                       |
| E3 — os três arquivos de teste                              | **observado**                                        | `Test Files 3 passed (3)`, `Tests 69 passed (69)` — idêntico ao baseline.                                                                                                                                    |

**Divergências entre o baseline da issue e o HEAD:** apenas movimentos de
linha. `classifyProviderError` está **byte-idêntico** ao SHA da captura (57
commits no intervalo; os que tocam `src/transports/errors.ts` mexem só em
`rethrowAborted` e `anthropicPartialUsage`, issue #567). Nenhum controle
mudou de resultado.

**Um achado novo, fora do baseline:** `acked_at` de um aviso reconhecido é
lido como `0` em todas as superfícies, e não como o instante do `ack`
(§ 4.3 e `evidencias.md` § 5). Encaminhamento proposto: conserto nas
fundações de M8, não trabalho de M12.

## 2. Matriz evidência → capacidade → lacuna → experimento → decisão proposta

As colunas "capacidade existente" citam o que **já foi entregue** em M8
(#396), M10 (#421) e M11 (#458); as colunas "lacuna" e "decisão" são
**propostas** desta investigação.

### 2.1 Classificação do sinal

| Campo                    | Conteúdo                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidência**            | E1 (400 do Codex → `unknown`, **simulado/determinístico**); E1b (404 da Anthropic → `model_not_found`, **observado ao vivo**); sonda do classificador (**determinístico**).                                                                                                                                                                                                                                                                                            |
| **Capacidade existente** | M8 #396/#397: vocabulário fechado `ERROR_KINDS` (10 valores, `src/transports/error-kinds.ts`); `classifyProviderError` (`src/transports/errors.ts:248`) nunca devolve silêncio — um `ProviderCallFailed` sem mapeamento vira `unknown`, nunca `null`.                                                                                                                                                                                                                  |
| **Lacuna (hipótese)**    | A recusa de modelo é reconhecida por **duas** condições conjuntas — `statusCode === 404` **e** `looksLikeModelNotFound` (que lê `code`, `payload.error.code`, `payload.error.type`, `message`, nunca um campo de topo do payload). O corpo de E1 falha nas duas: chega com `statusCode: 400` e com o texto em `payload.detail`, enquanto `providerFailure` (`src/transports/client.ts:298-315`) monta `message: "HTTP 400"` porque não existe `payload.error.message`. |
| **Experimento**          | Já executado: a sonda em `e1-a8b2fb1c/classificador-sonda.json` mostra que **mudar só o status para 404 não basta** (`unknown`), e que **pôr o texto do corpo na `message` só resolve com status 404** — os dois portões são independentes.                                                                                                                                                                                                                            |
| **Decisão proposta**     | Tratar isto como **conserto nas fundações de M8**, uma issue pequena e própria — não como capacidade nova de M12. Ver `taxonomia.md` § 3 para o discriminador candidato e `epicos-propostos.md` § 1.                                                                                                                                                                                                                                                                   |

### 2.2 Aviso durável, ack e leitura cross-process

| Campo                    | Conteúdo                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidência**            | E2 controles 2-4 (**simulado**); E1b (**observado ao vivo**: um aviso `model_not_found` escopado a `run:<id>`, lido de volta por `lohra workflow notices RUN_ID --all --json` num processo separado).                                                                                                                                                                                                                                     |
| **Capacidade existente** | M8: `operator_notices` com escopo, `seq`, fence, `ack`, retenção LRU por escopo (teto 256) e vocabulário `NOTICE_KINDS = ERROR_KINDS + STATE_NOTICE_KINDS`. M10 #426: `recordRouteFaultNotice` grava o aviso de rota com `kind = error_kind`, sem reclassificação por substring. A tool `workflow_notices` **sem `run_id` lista todos os escopos** (`src/tools/builtin-definitions.ts:636-641`) — a leitura entre tarefas já existe hoje. |
| **Lacuna (hipótese)**    | Não é armazenamento nem leitura: é **utilidade**. Um aviso é um registro por incidente, com texto livre na `message`; nada liga dois incidentes iguais, nada expira, nada mede se a leitura mudou o comportamento seguinte.                                                                                                                                                                                                               |
| **Experimento**          | `epicos-propostos.md` § 6 — instrumentar uso real por N sessões e contar (a) avisos por run, (b) avisos repetidos por `(kind, provider, model)`, (c) quantas vezes um agente chamou `workflow_notices` sem ser mandado.                                                                                                                                                                                                                   |
| **Decisão proposta**     | **Não** construir candidato a insight antes desse experimento. A superfície existente é a linha de base contra a qual qualquer estrutura nova precisa se justificar.                                                                                                                                                                                                                                                                      |

### 2.3 Preservação da causa

| Campo                    | Conteúdo                                                                                                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidência**            | E2 controle 1 (**simulado**): `faults[0]` carrega `Error code: 400 - {"detail":"The 'lohra-m12-modelo-inexistente' model is not supported…"}`. E1b (**observado ao vivo**): a auditoria mostra `workflow.fault` com `content: {state: "excluded_by_policy", characters: 37}`.                                   |
| **Capacidade existente** | A causa sobrevive em **três** camadas: no `payload` do `ProviderCallFailed`; no texto de `faults[]`, via `formatProviderFailureMessage` (`src/serialization/provider-error-message.ts`); e de forma durável em `prior_faults` no `pause_payload_json`.                                                          |
| **Lacuna (hipótese)**    | **A causa não se perde — o que falta é classificação.** A redação da auditoria (`policy.mode: "metadata_only"`) é política deliberada, não perda acidental: o ledger é trilha de execução, não cópia do corpo do provedor. Conflar as duas coisas levaria a propor "preservar a causa" onde o problema é outro. |
| **Experimento**          | Nenhum necessário: as três camadas estão nos arquivos de evidência.                                                                                                                                                                                                                                             |
| **Decisão proposta**     | Qualquer proposta de M12 **consome** a causa já preservada; nenhuma precisa afrouxar a política da auditoria.                                                                                                                                                                                                   |

### 2.4 Repetição do mesmo incidente

| Campo                    | Conteúdo                                                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidência**            | E2 controle 3 (**simulado**): um segundo run com a mesma rota inválida produz outra chamada ao provedor, outra pausa e um segundo aviso — nenhuma memória entre runs.                                                                                                                                                |
| **Capacidade existente** | M11 #458/#459: `workflow_routes.json` permite ao operador **pré-autorizar** fallbacks, e `withSuggestedRoute` preenche `suggested_route` na lição; o canal `route_envelope` (#460) pode aplicar a sugestão num resume sem `route`. Isso é conhecimento **do operador**, declarado antes, não aprendido do incidente. |
| **Lacuna (hipótese)**    | Nada converte "esta rota recusou" em "não tente esta rota de novo". Mas: **o controle não mede recorrência real** — a repetição foi pedida explicitamente ao simulador. Não há nenhuma medida de com que frequência isso acontece em uso normal.                                                                     |
| **Experimento**          | O mesmo de § 2.2: contar repetições por `(kind, provider, model)` em uso real antes de construir dedup ou invalidação.                                                                                                                                                                                               |
| **Decisão proposta**     | Adiar dedup, ranking, esquecimento e promoção automática até o experimento. É exatamente a armadilha do Python (2 registros em 32 bancos) que a M12 foi adiada para não repetir — e aquela estatística **não mede este runtime**.                                                                                    |

### 2.5 Memória e o que atravessa a delegação

| Campo                    | Conteúdo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidência**            | E2 (**simulado**): nenhum `MEMORY.md` criado nos runs repetidos. **Inferido** do código: `CHILD_EXCLUDED_TOOLS` (`src/tools/child.ts:5-29`) exclui `memory`, `skill_view`, `workflow_notices`, `workflow_notices_ack`, `run_workflow` e `workflow_status` do subagente; `SUBAGENT_ISOLATION` (`src/orchestration/subagent-prompt.ts:10`) declara ausência de memória/skills; `ConversationRuntime.promptSnapshot` (`src/conversation/runtime.ts:177-178`) memoiza o prompt com `this.prompt ??= …`. |
| **Capacidade existente** | Memória explícita por texto (`MemoryTool`, `src/tools/stateful.ts:21`), injetada no prompt como bloco `<memory>` (`src/context/system-prompt.ts:73`) **na construção**.                                                                                                                                                                                                                                                                                                                             |
| **Lacuna (hipótese)**    | Hoje **só a string da tarefa** atravessa a delegação. Um filho não lê avisos, não escreve memória e não vê o histórico do pai. O ausente de E2 (`memoryFilesCreated: false`) descreve o caminho mecânico exercitado — **não prova** que um orquestrador real seja incapaz de ler avisos, adaptar o plano e registrar memória; nenhum LLM real foi exercitado nesse controle.                                                                                                                        |
| **Experimento**          | Antes de qualquer canal novo: medir, no experimento de uso real, se um agente de verdade **já** usa `workflow_notices` e `memory` sem canal novo.                                                                                                                                                                                                                                                                                                                                                   |
| **Decisão proposta**     | Qualquer lição que precise alcançar um filho vai **pelo texto da tarefa ou por um campo novo de `SpawnConfig`** — nunca por reconstrução do prompt (invariante 1). Ver § 4.1.                                                                                                                                                                                                                                                                                                                       |

### 2.6 Escopo de tarefa

| Campo                    | Conteúdo                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidência**            | E2 controle 6 (**simulado**): a tarefa diz "leia somente A"; o modelo simulado pede B; a leitura de B é aceita; `status: complete`, `error_kind: null`.                                                                                                                                                                                   |
| **Capacidade existente** | Dois caminhos de filho, com sandboxes diferentes (`src/orchestration/core.ts:63-82`): uma folha durável de workflow recebe `wrapDispatch` com o sandbox instalado pela aquisição; `delegate_task`/`spawn_session` **não setam** `wrapDispatch` — o filho fica só com a deny-list (`read_file` não está nela).                             |
| **Lacuna (hipótese)**    | Não existe restrição **por tarefa** no caminho de `delegate_task`. Mas o controle mede exatamente isso e nada mais: **não** mede desvio espontâneo de um LLM, **não** mede fuga do sandbox de workflow, **não** mede acesso fora da pasta (os dois arquivos estavam na mesma pasta do projeto).                                           |
| **Experimento**          | A contraprova mais barata **não precisa de contrato novo**: repetir a mesma sonda como **folha de workflow** com `workflow_policy.json` `fs_allow` cobrindo só `task-a.txt` e esperar `sandbox_denied` em B. Isso dá "A permitido / B fora" em forma mecânica com as superfícies de M8/M10 que já existem. Detalhe em `taxonomia.md` § 4. |
| **Decisão proposta**     | Separar **restrição mecânica** (arquivos/ferramentas; verificável, já parcialmente disponível) de **desvio semântico** do objetivo (não verificável mecanicamente hoje). Só a primeira é candidata a épico agora.                                                                                                                         |

## 3. Abordagens comparadas

Os dois candidatos são avaliados **sobre os mesmos casos**: E1/E1b (recusa de
rota), E2 controle 3 (repetição), E2 controle 6 (escopo).

### Abordagem A — reaproveitar as superfícies existentes

Nada de armazenamento novo. O sinal já vive em `operator_notices`; a leitura
cross-run já existe na tool; a persistência já é durável, com fence e ack; a
memória explícita já existe. A abordagem consiste em: (i) consertar a
classificação para que a recusa chegue ao canal certo; (ii) instrumentar e
**medir** o uso dessas superfícies; (iii) melhorar a doutrina do prompt/skill
para que o agente as consulte.

| Critério                              | Avaliação                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Benefício em E1                       | Alto e imediato: com a classificação corrigida, o caso de E1 passa a produzir pausa + lição + aviso, como E1b já faz **ao vivo** hoje.             |
| Benefício em E2-3 (repetição)         | Parcial: o segundo run continua chamando o provedor; o que muda é que o operador (ou o agente) **vê** os dois avisos num único `workflow_notices`. |
| Benefício em E2-6 (escopo)            | Nenhum por si só; depende da contraprova de sandbox (§ 2.6).                                                                                       |
| Custo operacional                     | Baixo. Uma issue de classificação, uma de instrumentação, nenhuma migração de schema.                                                              |
| Acoplamento                           | Baixo: mexe num predicado de transporte e em documentação.                                                                                         |
| Confiança / dedup / invalidação       | Inexistentes por construção. Um aviso não tem confiança, não deduplica e não expira além do LRU de 256 por escopo.                                 |
| Risco de generalizar fora de contexto | Baixo: nada é reutilizado automaticamente; um humano ou um agente lê e decide.                                                                     |
| O que **não** resolve                 | Não produz nenhuma redução medida de erro em tarefa futura. Avisos armazenados e reconhecidos não são, sozinhos, evidência de aprendizado.         |

### Abordagem B — candidato a insight estruturado

Um registro novo, com campos obrigatórios: `{ escopo, proveniência (run/sub,
provedor/modelo, tarefa/projeto), condição observada, confiança, validade,
contraprova }`, produzido a partir de sinais classificados e consultado antes
de uma tentativa semelhante.

| Critério                              | Avaliação                                                                                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Benefício em E1                       | Nenhum adicional: sem a classificação corrigida (§ 2.1), o sinal de E1 nem chega à camada de insight. B **depende** do conserto de A.                                                                                                               |
| Benefício em E2-3 (repetição)         | Alto **se** a recorrência for real: um insight com escopo `(provedor, modelo)` evitaria a segunda chamada. Hoje a recorrência é **hipótese não medida**.                                                                                            |
| Benefício em E2-6 (escopo)            | Indireto: um insight não restringe nada; restrição é contrato, não conhecimento.                                                                                                                                                                    |
| Custo operacional                     | Alto: schema novo, migração, ciclo de vida (criação, invalidação, esquecimento), superfície de leitura, e um lugar onde erro de generalização vira comportamento.                                                                                   |
| Acoplamento                           | Alto: toca estado, engine, ferramentas e prompt ao mesmo tempo.                                                                                                                                                                                     |
| Confiança / dedup / invalidação       | É exatamente o que B fornece — e exatamente por isso não pode ser construído sem saber o que se quer deduplicar.                                                                                                                                    |
| Risco de generalizar fora de contexto | **Alto e específico**: o corpo de E1 diz "not supported **when using Codex with a ChatGPT account**" — a condição é da **conta**, não do modelo. Um insight sem o escopo da rota de autenticação ensinaria "este modelo não existe", o que é falso. |
| O que **não** resolve                 | Não gera a evidência de valor que justificaria a si mesmo.                                                                                                                                                                                          |

### Critério de recomendação e recomendação

**Critério declarado:** entre duas abordagens que atacam o mesmo caso, prefere-se
a que **(1)** tem benefício demonstrável sobre uma evidência já observada,
**(2)** o menor custo de reversão se a hipótese de valor não se confirmar, e
**(3)** produz a medida que decide a próxima. Em empate nos três, prefere-se a
que não introduz estado novo.

**Recomendação: A primeiro, B só depois do experimento de uso real.** A é a
única que tem benefício sobre evidência observada (§ 2.1, contra E1/E1b); B
depende de A para receber sinal e depende de uma hipótese de recorrência que
nenhuma evidência desta investigação sustenta — as duas sondas que "repetem"
repetem porque foram mandadas repetir.

**Isto não é uma rejeição de B.** É uma ordenação: B fica proposta, com o
experimento de § 5 como gate de entrada.

## 4. Proveniência, escopo, invalidação e delegação × invariantes

### 4.1 Prompt congelado (invariante 1)

**Fato inferido do código:** `ConversationRuntime.promptSnapshot`
(`src/conversation/runtime.ts:177-178`) faz `this.prompt ??= this.options.promptSnapshot()`
— o texto é construído uma vez e reusado. A memória entra ali como bloco
`<memory>` (`src/context/system-prompt.ts:73`), **na construção**. Um filho
recebe o prompt congelado no spawn (`buildSubagentSystemPrompt`,
`src/orchestration/subagent-prompt.ts:26`).

**Consequência para qualquer proposta:** uma lição escrita no meio da sessão
**não pode** aparecer no prompt vivo. Só duas rotas são compatíveis com o
invariante: (a) a lição vira **conteúdo de turno** (o agente a lê chamando
uma tool, como `workflow_notices` já permite); (b) a lição vira **campo da
tarefa** entregue ao filho no spawn. Nenhuma proposta desta nota pede
reconstrução de prompt vivo.

### 4.2 Proveniência mínima

A lição de rota já carrega `{error_kind, node_id, provider, model,
suggested_route}` (`src/workflow/route-faults.ts:64-86`) e o aviso é escopado
a `run:<runId>`. **Proposta:** a proveniência mínima para qualquer observação
reutilizável são cinco eixos, e os dois últimos são os que faltam hoje:

1. `run_id` / `sub_id` — já existe no escopo do aviso e no ledger.
2. `node_id` — já existe na lição.
3. `provider` / `model` — já existem na lição.
4. `tarefa` / `projeto` — **não existe**; o escopo do aviso é o run, e o run
   não carrega identidade de projeto.
5. **rota de autenticação** (`auth_route`: `api_key` × `subscription`) —
   **não existe** na lição, e é justamente o eixo que o corpo de E1 nomeia.
   Sem ele, qualquer generalização de E1 é falsa (§ 3, Abordagem B).

### 4.3 Invalidação

**Fato observado (novo, § 1):** um aviso reconhecido volta com
`acked_by: "cli"` e `acked_at: 0` — nos **dois** canais de leitura (tool e
CLI, mesmo valor). A causa está no código: a coluna é `acked_at REAL`
(`src/state/schema.ts:120`), `ack()` grava `Date.now() / 1_000`
(`src/state/notices-repository.ts:269`), e o leitor passa pelo
`nullableRowNumber` → `rowNumber`, que devolve **`0` para qualquer número que
não seja `Number.isSafeInteger`** (`src/state/notices-repository.ts:91-101`);
`created_at`, na linha 131, é lido com `Number(...)` direto e não sofre o
mesmo. **Consequência:** "quando este aviso foi reconhecido" é hoje
irrecuperável. Qualquer critério de invalidação por idade ("um aviso
reconhecido há mais de X") não tem em que se apoiar. Encaminhamento proposto:
conserto de fundação M8, issue própria (`epicos-propostos.md` § 2).

### 4.4 Budget e fan-out (invariante 3)

Nada nas propostas pode introduzir trabalho ilimitado. Os tetos que já
existem e que qualquer proposta herda: `NOTICES_SCOPE_CAP = 256` por escopo
com LRU (reconhecidos caem primeiro), `MAX_ROUTE_PIVOTS_PER_RUN = 3` por run
(um gate humano de facto), e `limit` clampado a 200 na leitura de avisos. Uma
camada de insight, se existir, precisa declarar o seu próprio teto **antes**
de existir.

### 4.5 Lease/fence (invariante 4)

`operator_notices` já grava sob `Ownership` (fence verificado contra
`workflow_run_fence` + `workflow_run_locks` antes do `INSERT`,
`src/state/notices-repository.ts:175-184`), e uma escrita recusada é contada
em `refused_writes`, nunca silenciosa. **Proposta:** qualquer estado novo de
aprendizado que seja escrito por mais de um processo usa o **mesmo**
mecanismo — não um segundo esquema de concorrência.

## 5. Experimento de uso real (resumo; detalhe em `epicos-propostos.md` § 6)

A sonda com modelo inexistente **não é** frequência de produção: ela foi
provocada de propósito, uma vez por controle, num ambiente construído para
falhar. Serve para medir **mecânica**, não taxa.

O experimento proposto mede recorrência e utilidade com baseline explícito,
observação esperada declarada antes, e teto de custo derivado de uma
suposição citada (não de um número inventado). Ver `epicos-propostos.md` § 6.

## 6. Critério de saída proposto para a M12

Proposta — a milestone hoje diz "a definir na abertura". Quatro dimensões,
cada uma com uma medida que pode ser verificada por um comando, e nenhuma
delas satisfeita por "o código existe":

| Dimensão                          | Critério mensurável proposto                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Qualidade da classificação**    | Um conjunto de corpos de erro reais (ou capturados) de ≥ 3 provedores, incluindo o corpo de E1, classifica no `ErrorKind` esperado; e ≥ 1 contraprova de 400 malformado continua em `unknown` — nenhuma regra que só saiba distinguir por status.                                            |
| **Persistência e ack de avisos**  | Para cada aviso durável: escopo, `kind` do vocabulário, `created_at` **e** `acked_at` legíveis depois do ack, em outro processo, com o `refused_writes` da integridade em zero. (Hoje falha: § 4.3.)                                                                                         |
| **Utilidade do reaproveitamento** | Uma comparação com baseline sobre tarefas reais em que a taxa de incidentes repetidos por `(kind, provider, model)` cai — ou, se não cair, a decisão explícita de **não** construir a camada. O critério é satisfeito pelos dois resultados; não é satisfeito por "a camada foi construída". |
| **Respeito ao escopo aplicável**  | Para o caminho onde a restrição é mecanicamente aplicável: a contraprova "A permitido / B fora" reprova B com `sandbox_denied` e aprova A no mesmo run. Para desvio semântico: o critério de saída declara explicitamente que **não** está coberto.                                          |

## 7. Menor primeiro passo justificável

**Consertar a classificação da recusa de rota nas fundações de M8** — uma
issue pequena, com dois portões nomeados (`taxonomia.md` § 2), contraprova de
400 malformado obrigatória, e sem nenhum estado novo. É o único item desta
investigação que:

- ataca uma evidência **já observada** (E1);
- tem benefício demonstrável **hoje** (E1b mostra o caminho feliz ao vivo);
- é pré-requisito de qualquer coisa que M12 venha a construir;
- e é reversível em um commit se a regra se mostrar ruim.

Tudo o mais fica atrás do experimento de uso real.

## 8. Limitações e questões abertas

1. **E1 não foi revalidado ao vivo na rota original.** O corpo do 400 é
   específico de Codex + conta ChatGPT; este ambiente roda em `api_key`.
   Habilitar assinatura é gate humano (segredos/auth), fora do escopo.
2. **Nenhuma medida de frequência em produção.** Nenhum número desta nota
   pode ser lido como taxa de falha real.
3. **Nenhum LLM real foi exercitado nos controles E2.** Todas as decisões do
   modelo foram programadas. As conclusões de E2 são sobre mecânica.
4. **Divergência `doctor` × `chat` observada e não investigada:** `doctor --json`
   reporta `environment.usable: true` com `detected_provider: anthropic`, mas
   `chat` **sem** `--provider` e fora de modo assinatura vai direto a
   `runChatBoundary` e devolve "no provider configured"
   (`src/commands/chat.ts:147-149`), com exit 2 e `api_calls: 0`. Achado
   colateral, fora do escopo desta issue; merece issue própria.
5. **`acked_at: 0`** (§ 4.3): reproduzível, com causa localizada; não
   corrigido aqui (esta entrega não toca `src/`).
6. **O experimento de uso real ainda não foi executado.** Toda a ordenação da
   § 3 depende do resultado dele.
7. **Questão aberta:** o eixo "rota de autenticação" (§ 4.2) deveria entrar na
   `RouteLesson` mesmo sem camada de insight? Isso mudaria o payload durável
   e merece decisão própria.
8. **Questão aberta:** o escopo de um aviso é `run:<runId>`. Um escopo por
   projeto/tarefa exigiria identidade de projeto no run, que hoje não existe.

## 9. AC da issue #574 × onde está atendido

| AC                                                                                                                            | Onde                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| E1–E3 classificados como observado/simulado/inferido, com SHA e comandos da revalidação                                       | § 0, § 1 e `evidencias.md` (inteiro)                                                                            |
| Diferencia M8/M10/M11 entregues, lacunas nessas fundações e trabalho novo; considera #426 e #440 sem tratá-los como prova     | § 2 (coluna "capacidade existente"), `epicos-propostos.md` § 1-2 (fundação) × § 3-4 (novo), `evidencias.md` § 6 |
| ≥ 2 abordagens comparadas sobre os mesmos casos, uma reutilizando as superfícies existentes; trade-offs e critério explícitos | § 3                                                                                                             |
| Experimento de uso real com baseline, observação esperada e teto de custo; a sonda não é frequência de produção               | § 5 e `epicos-propostos.md` § 6; ressalva em § 8.2 e `epicos-propostos.md` § 6.1                                |
| Proveniência, escopo, invalidação e o que atravessa a delegação, contra prompt congelado / trabalho limitado / lease-fence    | § 4.1–4.5                                                                                                       |
| Épicos com problema/User Story/AC/dependências/fronteiras/primeiro experimento/adiados; E1 com encaminhamento explícito       | `epicos-propostos.md` § 1–4 (E1 em § 1)                                                                         |
| Critério de saída distingue classificação, persistência/ack, utilidade e escopo aplicável                                     | § 6                                                                                                             |
| Nota referencia evidências reproduzíveis, limitações e questões abertas; propostas identificadas como propostas               | Cabeçalho, § 0, § 8, e o rótulo "proposta" em cada decisão                                                      |
