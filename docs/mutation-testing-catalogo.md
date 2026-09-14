# Catálogo de mutantes, por fatia

Narrativa cronológica de cada mutante acrescentado a cada catálogo de
`scripts/mutations/` — o que cada issue mudou, por quê, e qual `it` mata o
mutante. Mecânica do harness, formato de mutante/relatório, tabela de
contagens e o passo a passo de "como adicionar" ficam em
`docs/mutation-testing.md`; este arquivo é só a memória histórica por
catálogo (extraído de lá na issue #646 para caber no teto de 800 linhas —
ver `docs/mutation-testing.md#scriptsmutationsslicesjson-e-a-contagem-real-por-fatia`).

Cada seção agrupa a história de UM catálogo; dentro de uma seção, um
parágrafo às vezes menciona um mutante irmão que foi parar num catálogo
vizinho (ex.: issue #519 mexeu em `supervision-mutants.ts`,
`workflow-audit-producers-mutants.ts` e `context-window.ts` na mesma leva)
— a contagem "N → M" de cada parágrafo é sempre a do catálogo do título da
seção onde o parágrafo mora.

### `context-window.ts` (issue #293)

`context-window.ts` (issue #293) é o único catálogo que também é o próprio
runner — o `Files` da issue só autoriza um script novo, então os 15 mutantes
(`export const contextWindowMutants`) e a corrida (`main()`, atrás da mesma
guarda de entry-point dos outros seis) moram no mesmo arquivo, ao contrário
de `web-tools.ts`/`web-tools-mutants.ts` (runner e catálogo separados). Cobre
a compactação preflight (`src/conversation/compaction.ts`: limiar de
`compactionThreshold`, `CONSERVATIVE_RESERVE_RATIO`, corte de cauda alinhado
a turno), o latch de uma compactação por turno e o fail-open sem repositório
compactável (`src/conversation/runtime.ts`), o estimador de tokens ignorando
`tool_result`/overhead de mensagem (`src/context/token-estimate.ts`), a
precedência de `resolveContextWindow` e o separador do prefixo
(`src/providers/context-window.ts`), a fusão por modelo e o teto na leitura
do cache de janelas (`src/catalog/windows-cache.ts`) e o `compactHistory` da
issue #252 — lock checado na transação, `message_count` líquido e o filtro
`active` de `loadMessages` (`src/state/session-repository.ts`).

A issue #587 (P11, compactação/título pelo `AuxClient`) acrescenta 4 a
`context-window.ts`: `t` (`compaction.ts`'s `headAlignedKeepCount` perde o
fallback seguro "manter nada" — pode manter um `assistant` com `tool_calls`
sem manter seu próprio `tool`), `u` (`runtime.ts` para de derivar
`maxTranscriptTokens` da janela real, achado da própria issue: o default de
`compaction.ts` é inerte sob 200k), `v` e `w` (`src/agent/aux.ts`'s
`summarizeWithFallback` perde o `catch`, `auxTelemetry` para de contar
chamadas) — `aux.ts` não tinha mutante em NENHUMA fatia até aqui (achado da
QA de d56f9c9b): 19 + 4 = 23. A issue #620 (follow-up do veredito da PR #617)
acrescenta `x`: `aux.ts`'s `summaryBudgetFor` (o orçamento que
`AuxClient.summarize`/`AuxTelemetry.summarize` passam ao resumo) volta ao
`maxTokens` fixo em 1024 em vez de escalar com
`summaryMaxTokens(estimateTokens(transcript))` — o mesmo orçamento que
`buildSummaryRequest` (`compaction.ts`, issue #584) já usava para o
summarizer default: 23 + 1 = 24. A issue #608 (overlay de avisos: invariante
1 pinado) acrescenta `y`: `runTurn` passa a anexar o overlay de avisos
pendentes ao campo `system` do request (não só à mensagem do usuário, onde
ele deve viver) — invariante 1 (prompt construído uma vez e congelado) quebra
silenciosamente com um aviso pendente: 24 + 1 = 25. A issue #650 (item 13,
veredito da PR #625, non_blocking 2 "gasto órfão no caminho de erro")
acrescenta `z`, o primeiro mutante em `envelope.ts`: `errorEnvelope` para de
somar `extra.auxUsage` a `usage_total` — um turno que falha depois de um
título bem-sucedido (`defaultAuxModel`) perdia esse gasto do envelope de
erro: 25 + 1 = 26. A issue #649 acrescenta `aa`, primeiro mutante em
`runtime-session.ts`: `resolveTurnSession` recomputa via `promptSnapshot()`
uma sessão retomada em vez de reusar as faixas persistidas; morto por
`tests/conversation-runtime-prompt-caching.test.ts`: 26 + 1 = 27.

### `supervision-mutants.ts` (issue #451)

`supervision-mutants.ts` (issue #451, milestone 14 — achado de QA/revisão de
M10, épico #421) é o décimo terceiro catálogo, fatia nova: 227 + 19 = 246.
`npm run mutations:all` seguia 227/227 apesar de ~1.000 linhas novas em M10
(steer, leaf_read, route-faults, route-override, `dead_turn`) sem nenhum
mutante dedicado — 19 mutantes cobrindo `src/workflow/{steer-tool,
leaf-read-tool,route-faults,route-override}.ts`, `MAX_PENDING_STEERS_PER_LEAF`
em `src/orchestration/core.ts`, o guard de `dead_turn` em
`src/orchestration/child-runner.ts` e o vocabulário fechado de
`src/transports/error-kinds.ts`. `transports` sai de `SEM_FATIA` — a primeira
fatia a cobrir esse diretório. `srcGlobs` é `src/workflow/**` +
`src/orchestration/**` + `src/transports/**` (diretório inteiro cada, única
forma válida) — as duas primeiras já eram cobertas por `workflow-durability`/
`workflow-audit-live`, então a fatia nova dispara em paralelo a essas, não em
lugar delas. A issue #452 (pivô de rota em sub-workflow por ref, PR #472)
mergeou em paralelo a esta issue e acrescentou `overrideNestedSpec`
(route-override.ts) e sua chamada em `engine.ts`'s `runNested` — mais um
mutante (O5, morto por `tests/workflow-route-override-nested.test.ts`): 246

- 1 = 247. A issue #484 (milestone 15, achados dos vereditos das PRs
  #478/#482) acrescenta mutantes a `supervision-mutants.ts` para dois
  módulos de `src/workflow/**` (já coberto por `srcGlobs`) sem mutante
  nenhum. Rodada 1 (PR #497) trouxe `cache-preview.ts` (#462, 5 mutantes —
  P1 `pivots_used` incrementado, P2 `route_applied` invertido, P3
  `recompute` rotulado `replay`, P4 a classificação `nested` de um
  `workflow` node com guarda `&&` em vez de `||`, P5 `leaves_to_spawn`
  contando donos em vez de spawns) e `templates.ts` (#464, 3 mutantes — T1
  `TEMPLATE_REF` aceitando `/`, T2 `listTemplates` descartando um arquivo
  quebrado, T3 `readTemplateFile` engolindo `ENOENT` e devolvendo `{}`):
  247 + 8 = 255.

  A rodada 1 também tentou justificar a AUSÊNCIA do mutante de
  `PreviewCacheFacade.put()` que a issue original pedia, alegando que
  `put()` era código morto (todo `cache.put`/`cachePut` de `engine.ts` só
  dispararia com um leaf COMPLETO, e o `DryRuntime` do preview sempre
  devolve `status: "failed"`). O veredito da PR #497 (rodada 1) reprovou
  essa alegação: `engine.ts:480`'s `runParallel` chama
  `cache.put(runId, hash, ..., outputs, null)` **incondicionalmente**
  quando `outputs.every(nonEmpty)` — e `[].every(...)` é vacuamente `true`
  — então um `parallel` cujo `branches` resolve para `[]` chama `put()`
  sem nenhum leaf ter rodado, dry ou real (`schema.ts` valida
  `branches: []`; `budget.ts`'s `checkFanout(0)` nunca lança) — não é um
  caminho morto, é o único teste que faltava.

  O veredito também afirmou que `put`'s próprio `return false` era a
  ÚNICA barreira contra essa escrita alcançar `workflow_node_cache` de
  verdade. Essa segunda alegação também não se sustenta: `previewResume`
  constrói o `SqliteWorkflowCache` real que a facade envolve com uma
  `dummyOwnership` fixa (`fence: -1`, `holder: "preview"`) — e
  `workflow-repository.ts`'s `ownershipGuard` exige `fence` exato e um
  lock vivo do mesmo `holder` num `INNER JOIN` da `INSERT` guardada, então
  QUALQUER escrita por esse caminho é recusada (`cell.changes === 0`),
  delegando ou não. São duas barreiras independentes; um oráculo de
  contagem de linhas sozinho não distingue as duas. Rodada 2 acrescenta P6
  (`put()` passando a delegar a `this.real.put(...)`), ancorado num `it`
  novo em `tests/workflow-cache-preview-writes.test.ts` (arquivo novo — a
  suíte principal, `tests/workflow-cache-preview.test.ts`, está no teto de
  800 linhas) que roda um `parallel` de `branches: []` dependente de um nó
  `agent` fixado num provider inválido (`auth_failed` pausa a execução
  REAL antes de `par`, mas o `DryRuntime` do preview nunca pausa nesse
  fault genérico, então o preview alcança `par` de verdade) e afere DUAS
  coisas: a contagem de linhas de `workflow_node_cache` (pina a barreira 2)
  e as tentativas de `WorkflowRepository.putCacheCellWithCost` observadas
  por um `WorkflowRepository` de contagem injetado pelo mesmo seam
  (`deps.repository`) que `previewResume` já toma — essa segunda métrica é
  o que de fato mata P6, porque a barreira 2 zeraria a contagem de linhas
  de qualquer forma: 255 + 1 = 256. `slices.json#focusFiles` da fatia
  `supervision` ganha `tests/workflow-cache-preview.test.ts`,
  `tests/workflow-templates.test.ts` e
  `tests/workflow-cache-preview-writes.test.ts`.

  A issue #502 (non_blocking 4, veredito da PR #497) acrescenta P7/P8:
  `estimated_tokens_to_repay`/`estimate_basis` (`cache-preview.ts:116-117`,
  computados em `:388-390`) não tinham mutante nenhum apesar de `P1-P6`
  cobrirem o resto de `PreviewResult`. Um `it` novo em
  `tests/workflow-cache-preview-writes.test.ts` planta duas linhas em
  `workflow_node_cost` direto (mesma postura de "inserir a linha que o
  caminho de escrita real produziria" que `tests/state-audit-repository.test.ts`
  usa para `fieldMarkerRows`) com soma fracionária (average = 30.5) — P7
  remove o `Math.round()` (o valor sem arredondar, `30.5`, diverge do
  `31` esperado); P8 fixa `estimate_basis` em `null` mesmo com um average
  medido. Ambos ancorados no mesmo `it`: 256 + 2 = 258.

  A issue #503 (follow-up de #484 rodada 2, PR #497 veredito non_blocking 4) acrescenta P9: `classifyNode` (`cache-preview.ts`) caía em `unknown`
  para um `parallel` de `branches: []` cujo dry run já rodava até o fim
  (`cache.put([])`, o mesmo caminho que P6 prova) sem spawnar folha nem
  bater no cache — misturando "não modelado" com "rodou e não sobrou nada
  a pagar". Agora sai `no_leaves`; `unknown` continua reservado para o nó
  nunca alcançado ou para um tipo esta issue deliberadamente não modela
  (`verify`/`checkpoint`/`pipeline`, provado por um `it` de não-regressão
  com um `verify` na mesma forma). P9 reverte a string para `unknown`,
  morto pelo `it` de classificação novo em
  `tests/workflow-cache-preview-writes.test.ts`: 258 + 1 = 259.

  A issue #515 (follow-up de #503, veredito da PR #510, non_blocking 2 e 3)
  achou que o guard de `no_leaves` continuava tautológico DEPOIS do #503: o
  guard checava `spawns === 0 && hits === 0`, mas os dois já são
  garantidamente zero naquele ponto da função (os dois `return`s
  anteriores, para `spawns > 0`/`hits > 0`, já teriam saído antes) — a
  condição nunca discriminava nada. Isso misturava `branches: []` (de
  verdade "nada a pagar") com dois casos genuinamente bloqueados que também
  chegam ali com zero spawns/zero hits: `branches` que nunca resolveu para
  array (um template como `${bad.value}` sobre um upstream que falhou,
  `outputs[node.id] === null`, não `[]`) e um `parallel` que estourou o cap
  de fan-out (`FanoutRejected`, também `null`). O guard agora exige
  `Array.isArray(output) && output.length === 0` — só `[]` de verdade
  classifica `no_leaves`. O caso de `branches` não resolvida passa a
  classificar `upstream_missing` (o MESMO outcome que `agent` já reporta
  para um `${...}` não resolvido), checado com a MESMA precedência de
  `agent` — antes de `token_budget_exhausted` — via `hasNodeFault`: todo
  outro caminho de `runParallel` que produz `null` (`all N branches
failed`, `FanoutRejected`, um fault genérico do engine) grava um fault
  prefixado pelo próprio id do nó; só o `return null;` silencioso de
  `branches` não-array não grava nada, então "`null` e nenhum fault com
  esse prefixo" identifica exatamente esse caminho, sem precisar mexer em
  `engine.ts`. O cap de fan-out (que SEMPRE deixa um fault, `exceeds
max_fanout`/`exceeds lifetime remaining`) cai no `unknown` do catch-all —
  a issue decidiu não criar um outcome dedicado para ele, porque
  `capTrips` (`RunResult`) é uma contagem do run inteiro, não atribuível a
  este nó sem crescer `engine.ts` (congelado em 977 linhas — #540 reduziu
  de 978, ver mais abaixo). P10 mata a
  remoção do novo guard `Array.isArray`, ancorado no `it` novo de fan-out
  cap em `tests/workflow-cache-preview-writes.test.ts`: 259 + 1 = 260.

A issue #519 (M16-S4, épico #490, última sub-issue da milestone "Abort de
stream em voo") acrescenta 7 mutantes ao caminho de abort em voo já
mergeado (S1-S3/S5/S6). `supervision-mutants.ts` ganha três (issue #647
moveu os três para o catálogo irmão, `supervision-mutants-2.ts` — ver seção
própria abaixo): N1 (`client.ts`'s `AnthropicMessagesClient.stream` deixa de
encaminhar `signal` na request inicial), N2 (`child-runner.ts` troca o
`usage` de uma folha cancelada por `null` no `catch` de
`ConversationCancelledError` — reancorado pela issue #568 r2, veredito da PR
#573: o anchor original mirava `error.partialUsage` direto num argumento de
`zeroResult(...)`; hoje é `const usage = combineUsage(error.measuredUsage,
error.partialUsage);` que vira `const usage = null;`,
`supervision-mutants-2.ts:70`) e N3 (`orchestration-runtime.ts`'s teto
de `collect()`'s `deadlineMs`
alargado 10x) — 33 + 3 = 36. N3 originalmente mirava
`CANCEL_SETTLE_TIMEOUT_MS = 0` (a sugestão da própria issue #519), verificado
NÃO matar: o teste focal sugerido (`tests/workflow-abort-in-flight.test.ts`)
resolve inteiramente via microtasks, sem timer real nem I/O entre
`core.cancel()` e o assentamento — Node drena a fila de microtasks inteira
antes de QUALQUER `setTimeout`, incluindo um de 0ms, então a corrida nunca
alcança o teto não importa o valor. Retargetado no teto irmão da mesma
família de função — `collect()`'s `deadlineMs` (#521, M16-S6) — contra
`tests/workflow-orchestration-runtime-timeout.test.ts`, que usa uma
promise que nunca resolve: aí o teto é a ÚNICA coisa que pode assentar a
corrida, um kill determinístico de verdade.
`workflow-audit-producers-mutants.ts` ganha dois: B1 (`audit-model.ts`
remove `"partial"` de `BOOLEAN_FIELDS`, morto pelo `it` já existente de
`tests/workflow-audit-allow-list.test.ts` — não um arquivo novo, que
ficaria fora do allowlist fechado de
`tests/mutations-fixtures-workflow-audit.test.ts`) e B2 (`audit-runtime.ts`'s
`failedPayload(null, ...)` deixa de nomear `error_kind: "cancelled"`) — 25 +
2 = 27. `context-window.ts` ganha dois: p (`token-estimate.ts`'s
`estimatePartialUsage` cobra `partial.text` no fator JSON, mais denso, em
vez do fator de prosa) e q (`provider-model.ts`'s
`AnthropicMessagesModel.complete` deixa de encaminhar `request.signal` no
ramo streaming) — os dois vivem sob `src/conversation/**`/`src/context/**`,
cobertos pelo `srcGlobs` desta fatia, NÃO pelo de `supervision`
(`src/workflow/**`, `src/orchestration/**`, `src/transports/**`) como a
issue #519 sugeria (âncoras conferidas contra o HEAD, não contra o texto da
issue) — 15 + 2 = 17. Total: 260 + 7 = 267.

Issue #540 (limpeza pós-M18) acrescenta `V1-normalize-resume-id-trim-off-by-one`
a `supervision-mutants.ts`: `normalizeResumeId` (`src/orchestration/
validation.ts`) não tinha mutante em nenhum catálogo — a única garantia era
o `it` já existente de `tests/orchestration-tools.test.ts` (PR #523, QA de
87b9aeac). O mutante muta o comprimento aparado comparado no check de
ausência (`0` → `1`), fazendo uma string vazia escapar de `isAbsent`; morto
pelo `it` que já prova exatamente essa forma (empty/whitespace-only/null/
undefined → chave `resume_id` removida). `focusFiles` da fatia `supervision`
ganha `tests/orchestration-tools.test.ts` — 267 + 1 = 268.

Rodada 2 do veredito da PR #570 acrescenta `W1-nested-faults-fold-drops-prefix`:
o próprio commit que moveu o fold de `faults` aninhados de `engine.ts`'s
`runNested` para `foldNestedCounters` (`accounting.ts`, para não crescer
`engine.ts` acima do teto de 800 linhas) não trouxe mutante nenhum cobrindo
essa linha especificamente — nenhum catálogo mirava o `nestedScopePrefix`
usado ali. W1 remove o prefixo desse push (`result.faults.push(...nested.faults)`,
sem o `map`), morto pelo `it` já existente de `tests/workflow-nodes-tool.test.ts`,
"folds nested faults, node counts and all five cost meters", cuja asserção
`result.faults[0]).toContain("sub[inner]")` depende exatamente do prefixo.
`focusFiles` da fatia `supervision` ganha `tests/workflow-nodes-tool.test.ts`
— 268 + 1 = 269.

Issue #567 (veredito da PR #525, achado do "abort de stream em voo",
ADR 0005) acrescenta `N4-parse-sse-truncated-frame-atomic`: `parseSse`
(`client.ts`) era atômico — um `SyntaxError` no último `data:` truncado por
um abort em voo propagava para fora da função e descartava também os
eventos já parseados com sucesso, deixando `partial.text` vazio mesmo com
deltas completos antes do corte. N4 remove tanto o gate
`options.tolerateTruncatedTail !== true` quanto o `try`/`catch` que passou a
descartar só o frame truncado — não só o `try`/`catch` sozinho — voltando ao
parse incondicional que lança para fora em qualquer frame malformado
(caminho normal e caminho de abort tratados igual, como antes da issue
#567); morto pelo `it` novo de
`tests/transports-abort-in-flight.test.ts`, "ChatCompletionsClient.stream
replays the deltas already parsed when the trailing SSE frame is truncated
mid-abort (issue #567)" — 269 + 1 = 270. `focusFiles` da fatia
`supervision` não muda (`tests/transports-abort-in-flight.test.ts` já
estava lá, desde a issue #519).

Issue #568 (M16 pós-revisão, épico #561, sub S3+S6; vereditos das PRs
#528/#543, r2 de #556) acrescenta quatro a `workflow-audit-producers-mutants.ts`
(NÃO `supervision-mutants.ts`, que já estava no teto de 800 linhas — desde a
issue #647 o catálogo tem espaço de novo, mas a convenção passou a ser
diferente: mutante novo da fatia `supervision` entra no irmão
`supervision-mutants-2.ts`, seção própria abaixo):
C1 (`orchestration-runtime.ts`'s `Promise.race` em `cancel()` vira um
`await` direto de `this.core.collect(id, true)` — sem o teto, uma folha que
nunca assenta trava `cancel()` para sempre) e C2 (o `ceiling.clear()` de
`cancel()` removido — o timer do teto vaza quando a folha assenta antes
dele) são mortos por `tests/orchestration-runtime-collect.test.ts` (arquivo
novo, fake timers, molde de `tests/workflow-orchestration-runtime-timeout.test.ts`);
C3 (o `catch (error)` de `probeSettledAfterCancel` que nomeia o erro via
`warn` volta a ser um `catch {}` nu) e C4 (o filtro `result.status ===
"running" ? null : result` da mesma função é removido, deixando um
resultado "running" vazar como se tivesse assentado) são mortos por dois
`it` novos de `tests/workflow-abort-in-flight.test.ts`, contra um
`OrchestrationChildRuntime` de verdade (nenhum double). `focusFiles` da
fatia `workflow-audit-live` ganha os dois arquivos: 270 + 4 = 274.

Issue #569 (M16 pós-revisão, épico #561, S5) acrescenta dois a
`context-window.ts` (não `supervision-mutants.ts`, que seguia no teto de 800
linhas na época — nota da issue #568, acima; e não `core.ts` diretamente
— o fix do item 2, disarm-on-fire em
`OrchestrationCore.steer`, não tinha `focusFile` de `supervision` cobrindo
`tests/orchestration-steer-interrupt.test.ts`, e `slices.json` está fora do
`Files` da issue): `r-steer-interrupt-continue-ignores-outer-cancel` remove
o conjunto `&& !signalAborted(signal)` do `catch` de `runTurn`
(`runtime.ts:553`) que decide se uma chamada abortada é absorvível como
steer-interrupt — morto pelo `it` novo de `tests/conversation-runtime.test.ts`
que faz o `interruptSource` disparar `_abort` de verdade, correndo contra um
cancel externo, com um erro fora das três formas que `isAbortOf` reconhece
(a corrida com uma forma reconhecida resolve via `isAbortOf` primeiro,
antes de alcançar esse conjunto — não mataria o mutante). `s-per-call-
interrupt-hook-never-disarmed` remove o `disarm?.()` do `finally` de cada
chamada — morto pelo `it` já existente "freezes the prompt once, resumes
history, and commits complete turns", ao qual o mesmo `interruptSource`
foi acrescentado para provar que uma chamada bem-sucedida desarma o hook
também, não só uma abortada. 274 + 2 = 276.

Issue #594 (residual de M21) fecha as duas lacunas que #569 (acima) tinha
deixado documentadas. `focusFiles` de `supervision` ganha
`tests/orchestration-steer-interrupt.test.ts` e
`tests/orchestration-child-runner.test.ts`, e `supervision-mutants.ts`
acrescenta dois (39 -> 41): `X1-max-iterations-partial-guard-removed`
remove o guard `error.partialCalls > 0` de `child-runner.ts` (achado 2) —
sem ele, TODO `MaxIterationsError` reportaria `partial`/`usageUncertain`,
mesmo um cap-hit real sem chamada absorvida; morto pelo contra-caso
pinado em `tests/orchestration-child-runner.test.ts` ("maps
MaxIterationsError to status:'error' with the child's own leash"), não
pelo `it` positivo (que continua vendo `partial: true` de qualquer jeito
sob esse mutante). `Y1-steer-fire-not-idempotent` (achado 3) remove a
nulificação de `entry.interrupt` DENTRO de `fire` (`core.ts`, "fire
idempotente") antes de chamar `abort()` — morto pelo `it` já existente "a
second steer while the first's interrupt is still in flight...".

### `supervision-mutants-2.ts` (issue #647, grupo A de #637)

Segundo catálogo da fatia `supervision` (8 mutantes): `supervision-mutants.ts`
(issue #451) chegou a EXATAMENTE 800 linhas — as issues #568 e #569 (acima)
já tinham desviado mutante para `workflow-audit-producers-mutants.ts` e
`context-window.ts` só por causa disso — e o achado seguinte de M22/M23
(#637, grupo A, item 6) não tinha mais onde morar sem apagar prosa. Um
arquivo separado (não um `Files` que autorizasse crescer
`supervision-mutants.ts` além do teto) porque `supervision.ts`'s `main()`
concatena os dois catálogos numa só corrida de `npm run
mutations:supervision` — mesmo padrão de `context-window.ts`/
`context-prompt-mutants.ts` (issue #646).

Recebe, movidos byte a byte (`before`/`after`/`focus` inalterados), os 8
mutantes N1-N4/V1/W1/X1/Y1 que fechavam o catálogo original: N1
(`client.ts`'s `AnthropicMessagesClient.stream` sem `signal` na request
inicial, issue #519), N2 (`child-runner.ts` troca `usage` por `null` no
`catch` de `ConversationCancelledError`, reancorado pela #568 r2), N3
(`orchestration-runtime.ts`'s teto de `collect()`'s `deadlineMs` alargado
10x, #521), N4 (`client.ts`'s `parseSse` volta a ser atômico no abort,
#567), V1 (`validation.ts`'s `normalizeResumeId` — off-by-one no trim,
#540), W1 (`accounting.ts`'s `foldNestedCounters` perde o prefixo do fold
de faults aninhados, #540 r2), X1 (`child-runner.ts`'s guard de
`MaxIterationsError.partialCalls`, #594 achado 1/2) e Y1 (`core.ts`'s `fire`
idempotente, #594 achado 3). A soma da fatia não muda (41 = 33 + 8); a
divisão é só de onde cada mutante mora — narrativa completa de cada um na
seção `supervision-mutants.ts` acima, cronológica por issue.

A partir desta issue, o próximo mutante da fatia `supervision` entra aqui,
não em `supervision-mutants.ts` — que voltou a ter espaço (33/800), mas a
convenção passa a ser a mesma de `context-window`: catálogo antigo fica
estável, achado novo vai para o irmão.

### `workflow-executor-mutants.ts` (issue #418)

`workflow-executor-mutants.ts` (issue #418) acrescentou
`Q1-quota-guard-removed`: a guarda que impede `quota_exhausted` de entrar em
`fault_kinds`, morta por `tests/workflow-fault-kinds.test.ts` (issue #412) —
o sexto arquivo de `focalTests`/`focusFiles` da fatia (44 → 45). Issue #426
generalizou a guarda de `!== QUOTA_EXHAUSTED` para `!pausesRun(...)`
(`engine-utils.ts:487`, também cobre os três kinds de rota) — mesmo id de
mutante, `before`/`after` re-ancorados na mesma PR. Issue #647 (grupo A de
#637, item 1; follow-up do veredito da PR #609) acrescenta
`R1-recollect-fallback-last-wins`: o retry de validação de schema
(`engine.ts:333`) re-extrai `output` a cada re-collect mas precisa manter
`usedFallback` pinado na 1ª leitura (#602) — sem esse pino, um nó cuja
correção troca tool-por-prosa (ou vice-versa) deixaria a extração do retry
sobrescrever a métrica. O mutante ("última leitura vence",
`({ output, usedFallback } = extractForcedOutput(collected, forced))`) só
morre com uma bateria que force `forced: true` E tenha `toolCalls` na
retentativa — `tests/workflow-forced-fallback.test.ts` não estava em
`focalTests`/`slices.json#focusFiles` até esta issue (achado do próprio
veredito da PR #609, que não pôde incluir o mutante porque `slices.json`
estava fora do `Files` daquela issue): sétimo arquivo da bateria (45 → 46).

### `workflow-audit-producers-mutants.ts` (issue #370)

`workflow-audit-producers-mutants.ts` (issue #370) estende `workflow-audit-live`
aos produtores novos do M7 que os 32 mutantes originais não cobriam:
`segment_id` omitido, a regra fail-closed desligada e o flush antes de
liberar a lease pulado (`audit-producers.ts`, identidade causal #365), a
ordem `segment.started`/`workflow.plan` e o `process_crash` de uma retomada
de dono morto (`audit-producers.ts`, #368), o terminal único por `sub_id`, o
timeout como `cancelled` e o `node_path` achatado numa folha aninhada
(`audit-runtime.ts`, folhas #366), a identidade e a classificação de uma
recusa síncrona do sandbox (`audit-runtime.ts`, ferramentas #367), um hit de
cache relatado como miss e uma escrita recusada relatada como armazenada
(`audit-cache.ts`, #368), e o teto de bytes, o desconto por bytes na janela,
a contagem de `dropped`, o teto de runs conhecidos evictando um run vivo e o
cursor regredindo em `forget()` (`live-tail.ts`, #369). Os 18 mutantes
originais têm foco nos seis arquivos de teste novos do M7
(`workflow-audit-identity`, `-leaf`, `-tool`, `-cache`, `-segment`,
`workflow-live-tail`).

Quatro mutantes da tabela inicial da issue #370 ficaram de fora,
deliberadamente: `P5-crash-on-clean-resume` (`service.ts` ou produtores — um
`orphaned` ignorado sempre gravaria crash, foco `workflow-audit-segment`),
`L3-attempt-zeroed` (`audit-runtime.ts` — `attempt` fixo em 0, foco
`workflow-audit-leaf`), `R2-drop-newest` (`live-tail.ts` — descarta o mais
novo em vez do mais velho, foco `workflow-live-tail`) e
`W1-watch-events-repeat` (`src/commands/workflow.ts` — cursor não avança,
foco `workflow-watch-events`). `R2-drop-newest` já havia sido tentado:
sobreviveu à primeira corrida real (nenhum teste prendia a ordem FIFO da
evicção) e foi trocado por `R2-byte-trim-disabled`, deixando a lacuna de
oráculo aberta; `L4-wait-false-closes` (`collect()` com `wait:false`
retornando `"running"`) e a allow-list de `event_type` aceitando string
livre (`audit-model.ts`) eram outras duas lacunas da mesma lista, sem `id`
formal na tabela inicial.

A issue #383 fecha DUAS das quatro lacunas nomeadas acima — `R2`
(agora `R6-drop-newest`, já que o `id` `R2` estava reaproveitado por
`R2-byte-trim-disabled`) e `W1` (mesmo `id`, `W1-watch-events-repeat`, agora
um mutante real) — mais cinco mutantes novos, sete no total (18 → 25):
`L4-wait-false-closes` e `M1-allowlist-free-string` (a allow-list de
`event_type` em `audit-model.ts`, ancorada na CHECAGEM, não no conteúdo do
`SAFE_EVENT_TYPES`), `W2-audit-trail-warning-unwired` (a fiação
`{ warning: auditWarning }` do `AuditTrail` de `chat.ts`, veredito da PR
#384/#380), `T3-cancel-flush-skipped` (o laço de flush de `close()` para
dispatches de ferramenta ainda abertos, veredito da PR #385) e
`PD-pending-never-reported` (o relato de `pending` de `workflow_audit`,
issue #373/PR #389). `P5-crash-on-clean-resume` e `L3-attempt-zeroed`
continuam de fora — fora do escopo de #383.

### `auth-mutants.ts` (issue #354)

`auth-mutants.ts` (issue #354, +4 na rodada 1 e +1 na rodada 2 da issue
#356) cobre a lease de arquivo sobre a renovação do token OAuth
(`src/auth/lease.ts`: TTL zerado, lease órfã não tomada de volta, release
sem checar o dono) e a coordenação em `src/auth/credentials.ts` (janela de
"ainda expirando" zerada, o ramo que adota o token que outro processo já
escreveu, a identidade de `RefreshFailedError` quando o refresh falha de
verdade, e a identidade de `TokenPersistError` quando o refresh funciona
mas a escrita em disco falha — issue #354, achado 2 da PR #352: essa
escrita vive fora do `try` do POST). Os 4 mutantes da rodada 1 da issue
#356 cobrem o fail-closed de `isLeaseAlive` para um lock ilegível
(fallback por `mtime + ttlSeconds` desativado), o dono pulando a releitura
sob a lease antes de repetir o refresh, o deadline do perdedor em
`waitForFileLease` (`>=` virando `>`), e a identidade de
`TokenPersistError` quando `acquireFileLease` propaga um erro real (não
`EEXIST`) em vez de `RefreshFailedError`. O mutante da rodada 2 cobre
`waitForFileLease` deixando de usar `isLeaseAlive` para um lock ilegível
persistente (os dois leitores da lease voltando a discordar sobre o que é
"viva"). Todos os 13 mutantes têm foco em `tests/auth-core.test.ts`.

### `doctor-mutants.ts` (issue #636)

`doctor-mutants.ts` (issue #636, follow-up da QA de 846b0b7f e das PRs
#629/#632/#634) é a fatia mais nova: 11 mutantes cobrindo
`src/doctor/snapshot.ts` (`route.error` ignorado na decisão de
`chat_default_provider`, o modo `subscription` caindo em
`detectChatProvider` como se fosse `api_key`, `usable` sem `ollama.alive`,
`usable` sem `hasApiKey`, `provider_origin` reportando `"api-key"` em vez de
`"none"` quando nada foi detectado), `src/doctor/checks.ts` (`isOllamaReady`
com `||` em vez de `&&`, o Check `ollama-sem-chave` emitindo sem checar
`auth_route === "api_key"`, emitindo com `chat_default_provider !== null`
em vez de `=== null`, e o `remedy` desse Check sem `--provider ollama`),
`src/doctor/providers.ts` (`detectConfiguredProvider` devolvendo
`AUTO_PROVIDER` como se fosse um provedor detectado) e
`src/commands/provider-detectado.ts` (`detail` descartado no caminho de
erro, fail-open em vez de propagar a causa). `srcGlobs` é
`["src/doctor/**", "src/commands/**"]` — o segundo glob existe só porque
`src/commands/provider-detectado.ts` não é um arquivo de topo de `src/`
("Forma dos `srcGlobs`", acima) e o diretório `commands` já era coberto por
`workflow-audit-live`/`self-update`, então a fatia nova dispara em paralelo
a essas, não em lugar delas. O mutante de `provider_origin` é o único cujo
oráculo mora fora dos três arquivos de foco da própria fatia
(`tests/cli-doctor.test.ts`, `tests/doctor-checks-ollama.test.ts`,
`tests/chat-provider-detectado.test.ts`): `tests/providers.test.ts`'s
"exercises whitespace key and invalid provider through doctor" já pinava
`provider_origin: "none"` para `LOHRA_PROVIDER` desconhecido, então
`focusFiles` ganha esse quarto arquivo em vez de inventar um teste novo
(fora do `Files` da issue #636).

### `context-prompt-mutants.ts` (issue #646, sub-issue A1 de #637)

Segundo catálogo da fatia `context-window` (16 mutantes): cinco issues de
prompt em M22 (#579, #582, #588, #587, #620) mergearam código novo em
`src/context/doctrine.ts`, `src/context/system-prompt.ts` e
`src/context/discovery.ts` sem nenhum mutante mirando esses arquivos —
achado de #637. Um arquivo separado de `context-window.ts` (que já está em
679 linhas) porque o `Files` da issue não autoriza crescer aquele arquivo
além do teto de 800 — `context-window.ts`'s `main()` concatena os dois
catálogos numa só corrida de `npm run mutations:t23`.

`doctrine.ts` (4): `resolveDoctrineTier` ignora `LOHRA_DOCTRINE` (kill
`tests/context-doctrine.test.ts`, "LOHRA_DOCTRINE=core overrides an
extended default"), o valor inválido deixa de lançar e cai silenciosamente
no default (kill "fails closed on an invalid LOHRA_DOCTRINE instead of
silently falling back"), `CORE_ONLY_PROVIDERS` fica vazio (kill "defaults
ollama ... to core") e `doctrineText("extended")` devolve só o core (kill
"appends the extension after the core for tier 'extended'").

`system-prompt.ts` (5): `doctrine` sai da faixa `stable` (kill
`tests/context.test.ts`, "places doctrine in the stable band, after
identity and before Environment"), `MEMORY_PREFIX`, `USER_PROFILE_PREFIX`
e `PROJECT_INSTRUCTIONS_PREFIX` apagados (kill os três testes de "prefix
frames for memory, user profile, and project instructions (#582)") e
`ENVIRONMENT_SNAPSHOT_NOTE` apagada da nota do bloco `Environment:` (kill
"appends the snapshot note when at least one environment hint is
present") — os quatro fecham gaps que os vereditos das PRs #614/#617 já
tinham apontado ("nenhum mutante mira MEMORY_PREFIX...").

`discovery.ts` (4): `dedupeIdenticalContent` devolve a entrada sem agrupar
(kill `tests/context.test.ts`, "dedupes identical content into one entry
with a composite label"), `GIT_TIMEOUT_MS` 500ms → 30s (kill
`tests/context-discovery.test.ts`, "never throws and omits git_* keys when
git times out"), o teto de 20 linhas do `git_status` sobe para 1000 (kill
"truncates git_status at 20 lines with a marker") e `gitDefaultBranch` para
de cortar o prefixo do remote, devolvendo `"origin/main"` inteiro em vez de
`"main"` (kill "reports git_default_branch only when
refs/remotes/origin/HEAD is set locally").

`aux.ts`/`compaction.ts` (3): as duas seções verbatim de `SUMMARY_SYSTEM`
("User Asks, Verbatim" e "Constraints And Prohibitions, Verbatim") perdem a
palavra "Verbatim" (kill `tests/client-pool-aux.test.ts`, "asks for the two
verbatim sections and the non-attribution rule, by text (issue #584)") e
`buildTranscript` passa a manter a CAUDA das mensagens dobradas em vez da
CABEÇA quando o transcript excede o orçamento (kill
`tests/conversation-compaction-verbatim.test.ts`, "cuts from the tail at
the nearest turn boundary once the transcript exceeds the budget, keeping
the head (and an early prohibition in it) intact").

Mais dois mutantes de fiação, em catálogos de fatias vizinhas que já cobrem
`src/commands/**`/`src/orchestration/**`: `self-update-mutants.ts` ganha
`T22-dashboard-doctrine-dropped` (`src/commands/dashboard.ts`'s
`doctrineText(resolveDoctrineTier(...))` some, kill
`tests/gateway/dashboard-prompt-contract.test.ts`, "a real WS turn's system
message carries identity, memory, user profile, and the skills index —
none of which dashboard sent before this issue"; 8 → 9) e
`orchestration.ts` ganha `as/subagent-prompt-doctrine-dropped`
(`src/orchestration/subagent-prompt.ts`'s `doctrine: DOCTRINE_CORE` vira
`undefined`, kill `tests/orchestration-subagent-prompt.test.ts`, "orders
identity+isolation, doctrine, harness, Environment, tools contract, then
the date"; 5 → 6). `chat.ts:329-331` e `serve.ts` seguem sem mutante de
doutrina — `serve.ts` porque não há teste que leia o prompt real que ele
manda (achado A3, fora do escopo desta issue).

`tests/context.test.ts` também ganha um pino novo, fora deste catálogo: o
`.text` inteiro de um prompt sem blocos opcionais, por igualdade
(`toBe`) — até aqui a byte-compat era pinada só por ausência
(`not.toContain`), nunca por igualdade exata (veredito da PR #614).
