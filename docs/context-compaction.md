# Compactação preflight

Como `ConversationRuntime` evita estourar a janela de contexto de um modelo
(issue #252, última sub-issue do épico #230 "Janela de contexto: compactar
antes de estourar"). Liga três peças que sub-issues anteriores construíram
sem nenhum chamador: `resolveContextWindow` (#250,
`src/providers/context-window.ts`), `estimateTokens` (#251,
`src/context/token-estimate.ts`) e a tabela `compression_locks` +
`LockRepository` (`src/state/locks.ts`, existia desde antes do épico, sem
chamador até aqui).

## Decisão: reescrever o histórico em vez de encerrar a sessão

A issue deixava a escolha em aberto: (i) reescrever o histórico da sessão
**no lugar**, com um marcador durável, ou (ii) encerrar a sessão com
`end_reason=compression` e abrir uma continuação (o gateway já tem
mecanismo de "ressuscitar" uma sessão assim — `GatewaySessionRegistry`,
`src/gateway/session-service.ts`, ADR-T12-04).

Este runtime escolheu **(i)**. Dois fatos decidiram:

- A tabela `messages` já tem a coluna `active` (`src/state/schema.ts:25`,
  `idx_messages_session` já indexada por `(session_id, active, id)`) — ela
  existe precisamente para isto: desativar as mensagens resumidas e inserir
  o resumo como uma mensagem nova, sem precisar de um id de sessão novo.
- A opção (ii) precisaria de bem mais superfície nova para o mesmo
  resultado: um novo `session_id` que voltasse a circular pelo `--session`
  de resume da CLI, pelo envelope `--json`, e pela contabilidade de
  `parent_session_id`/`knownSessionIds` do gateway — que hoje **recusa**
  justamente sessões vinculadas por `parent_session_id` como `"subsession"`
  na submissão de prompt (`GatewaySessionRegistry.promptSubmissionRejection`).
  Reaproveitar esse caminho para uma continuação de compactação teria que
  abrir uma exceção nova nessa recusa, em vez de reaproveitar nada.

Resultado: `SessionRepository.compactHistory` (`src/state/session-repository.ts`)
nunca chama `endSession`, e uma sessão compactada continua exatamente tão
submissível no gateway quanto antes (`tests/gateway-compaction.test.ts`,
descrição "stays submittable across a compaction"). `end_reason=compression`
continua servindo só ao mecanismo de resurrection pré-existente
(ADR-T12-04) — as duas coisas nunca se cruzam.

## A rotina, passo a passo

Em `ConversationRuntime.runTurn` (`src/conversation/runtime.ts`), no topo de
cada iteração do turno, antes de montar a chamada ao provedor:

1. **Estimar** (`estimateRequestTokens`, `src/context/token-estimate.ts`):
   soma o histórico + a mensagem do turno em andamento (via `estimateTokens`),
   o prompt de sistema e as definições de tool — as duas últimas passam ao
   provedor fora do array `messages`, e um estimador que só olhasse
   `messages` erraria por exatamente esse tanto (nota do revisor da PR
   #267/#270 na issue #252).
2. **Resolver a janela** (`resolveTurnContextWindow`,
   `src/conversation/compaction.ts`): `resolveContextWindow` (#250) com o
   `ProviderProfile` do provedor do turno (`getProviderProfile`, com um
   caso especial para `CODEX_PROVIDER` — ele nunca é registrado no catálogo
   por nome porque não é selecionável via `--provider`, mas o turno ainda
   passa `provider: "openai-codex"`) e o override de
   `LOHRA_CONTEXT_WINDOW` (`resolveContextWindowOverride`,
   `src/config/context-window-env.ts`) lido de `options.environment` (default
   `process.env` — nenhum chamador precisa passar isso explicitamente).
3. **Comparar contra o limiar** (`compactionThreshold`): a estimativa cabe
   se for `≤ janela − maxTokens − margem`. A margem é 8% da janela quando a
   fonte da janela é `table`/`catalog`/`override` (medida ou configurada
   explicitamente) e **15%** quando é `provider`/`default` — o piso de
   1.050.000 do perfil Codex, por exemplo, é um número lido de uma página
   de docs (`docs/context-window.md`), não uma medição em runtime; nota do
   revisor da PR #270 na issue #252 pede folga extra exatamente nesse caso.
4. **Se couber**, segue sem tocar em lock nem I/O — caminho rápido, sem
   custo para o turno comum.
5. **Se não couber e o turno ainda não compactou desta vez**, tenta
   compactar (`attemptCompaction`, `src/conversation/compaction.ts`):
   - Adquire `compression_locks` para a sessão, com até 3 tentativas
     (invariante 3: nunca espera sem limite) — lock ocupado além disso vira
     `CompressionLockBusyError`.
   - Sob o lock, **relê** o histórico persistido (outro processo pode já
     ter compactado) e decide quantas mensagens finais preservar intactas
     (`turnAlignedTailCount`): anda de trás para frente a partir do piso
     configurado (`minKeepMessages`, default 8) até achar a mensagem
     `role: "user"` mais próxima — todo turno começa com `user`, então
     parar aí garante que uma mensagem `tool_calls` nunca fica separada do
     seu resultado, e que o par resumo (inserido como `user`+`assistant`,
     veja abaixo) é sempre seguido por `user`.
   - Se não sobrar nada para resumir, devolve "nada compactado" (o caso
     fútil).
   - Caso contrário, resume o trecho antigo com o **transporte do próprio
     turno** (mesmo modelo, prompt `SUMMARY_SYSTEM` de `src/agent/aux.ts`) OU,
     desde a issue #587, com `options.summarize` injetado por
     `chat.ts`/`dashboard.ts` a partir de `AuxClient.summarizer()` — seção
     "Compactação e título pelo AuxClient" adiante — e chama
     `SessionRepository.compactHistory`, que reescreve tudo numa transação:
     desativa as mensagens antigas, insere **duas** mensagens novas —
     `buildSummaryMessages` (`src/conversation/compaction.ts`): uma
     mensagem `user` sintética ("(resumo da conversa anterior a seguir)")
     seguida da mensagem `assistant` com o resumo em si, nunca só a
     `assistant` sozinha. A API de Messages da Anthropic recusa (400)
     qualquer requisição cuja primeira mensagem não seja `role: "user"` —
     sem esse lead, todo turno pela rota Anthropic quebraria na primeira
     compactação da sessão. Depois das duas, **reinsere** as mensagens
     preservadas com ids novos — preservar os ids antigos faria o par
     resumo (ids mais altos, por serem os mais recentes) ficar **depois**
     delas em `loadMessages` (que ordena por `id`), invertendo a ordem.
   - Libera o lock sempre, em `finally`.
6. **Latch**: se depois de compactar a nova estimativa ainda não couber, ou
   se o turno já tinha compactado uma vez e estoura de novo, o turno falha
   com `ContextWindowExceededError` (`CONTEXT_WINDOW_EXCEEDED`) — nunca uma
   segunda tentativa de compactação no mesmo turno.

## Evento e envelope

`ConversationRuntimeEvent` ganha o tipo `"session.compacted"`, emitido com
um payload `{ summarizedCount, keptCount, estimateBefore, estimateAfter }`
(`src/conversation/types.ts`) — mesma forma espelhada em
`SessionCompacted`/`ChatEvents["compacted"]` (`src/events/protocol.ts`),
o protocolo de eventos que uma TUI/GUI futura consome (esse tipo
`ChatEvents` em si continua sem emissor — a #287 liga `eventSink` do
`ConversationRuntime`, não `protocol.ts`; o frame que o gateway ws manda é
JSON-RPC cru, não o `ChatEvents` tipado). `ConversationTurnResult.compaction`
carrega o mesmo resumo quando uma compactação rodou no turno; `successEnvelope`
inclui a chave `compaction` só nesse caso (ausente, nunca `null`, quando não
rodou — as fixtures de `tests/conversation-envelope.test.ts` que nunca
passam esse campo mantêm a mesma contagem de chaves).

Até a issue #287, nenhum chamador de produção ligava `eventSink` — o
evento só chegava a um sink fake de teste. Agora `commands/chat.ts` e o
gateway ws (`src/gateway/ws/connection.ts`) ligam: `chat.ts` acumula uma
linha `event: session.compacted summarized=<N> kept=<M>` (ou `event:
compaction.unsupported`) e a imprime em `stderr`, ao lado do aviso de
sessão de sempre — o `--json` da mesma chamada continua reportando o fold
por `compaction` no envelope, como já fazia; o `stderr` é o que torna o
evento em si observável fora dele. O gateway ws encaminha os dois tipos
como frames `event` no socket (mesmo shape de `encodeGatewayEventFrame`,
`src/gateway/rpc/frame.ts`, mas montado localmente em `connection.ts` —
`GatewayEventName` ali é uma união fechada essa issue não alarga), ao
lado dos já existentes `message.*`/`tool.*`. `commands/dashboard.ts`'s
cron job runtime continua sem `eventSink` — fora do escopo da #287.

Na mesma revisão: `SessionRepository.searchMessages`
(`src/state/session-repository.ts`) passou a exigir `active = 1` — o
trigger `messages_fts_ai` (`src/state/schema.ts`) nunca remove uma linha
do índice FTS quando uma compactação a desativa, então a busca podia
devolver a mesma mensagem duas vezes (a linha antiga e a que a
substituiu). E `attemptCompaction` (`src/conversation/compaction.ts`)
embrulha o `Error("COMPRESSION_LOCK_NOT_HELD:...")` cru que
`compactHistory` lança (quando o holder perde a trava entre o acquire e o
uso — uma janela real, não hipotética) em `CompressionLockNotHeldError`
(`src/conversation/errors.ts`, código `COMPRESSION_LOCK_NOT_HELD`), então
`runTurn` reporta esse código em vez do genérico `TURN_FAILED`.

## Fora de escopo desta issue

- Compactação de folhas de workflow (issue #252, seção "Fora de escopo").
- Cache do catálogo (`loadWindowsCache`, #249) na resolução da janela
  dentro do preflight — `resolveTurnContextWindow` passa `catalog: undefined`
  de propósito, então a resolução aqui nunca sobe além de `table`/`provider`/
  `default`/`override`; ligar o catálogo é trabalho futuro, não regressão
  desta issue.
- `attemptCompaction` relê o histórico sob o lock antes de resumir (outro
  processo pode já ter compactado), mas não recompara essa releitura contra
  o limiar antes de seguir — se o histórico já estiver dentro do limiar
  nesse ponto, ainda assim compacta de novo (resumo-de-resumo). Barato
  (nunca incorreto: a trava impede colisão de escrita, e o resultado
  continua consistente), mas redundante nesse caso raro; recomparar
  exigiria levar o limiar/estimativa para dentro de `attemptCompaction`,
  fora do escopo M desta issue.
- Um summarizer dedicado com modelo/preço próprios (`AuxClient`,
  `src/agent/aux.ts`) e levar o limiar/janela REAL do turno para dentro de
  `attemptCompaction` **não são mais fora de escopo** — a issue #587 (P11)
  fechou os dois: `chat.ts`/`dashboard.ts` injetam `options.summarize` a
  partir de `AuxClient.summarizer()` quando o perfil tem `defaultAuxModel`
  (fallback ao summarizer default do próprio turno em caso de falha, evento
  `compaction.aux_fallback`), e `ConversationRuntime.preflightCompact` passa
  `maxTranscriptTokens` derivado de `resolveTurnContextWindow` a
  `attemptCompaction` — o default autocontido de `compaction.ts` (seção
  abaixo) só vale quando o chamador não passa esse campo. Ver "Compactação e
  título pelo AuxClient (issue #587)" adiante.

## Compactação preserva pedidos e restrições verbatim (issue #584)

Três ajustes, todos em `src/agent/aux.ts` e `src/conversation/compaction.ts`
(`SessionRepository`, `src/state/session-repository.ts`, ganha só a troca de
um texto). Motivação: com os oito headings originais, uma proibição dita no
começo de uma sessão longa só sobrevivia à compactação se o modelo a
julgasse "ainda relevante" e coubesse nos 1024 tokens fixos do resumo junto
com todo o resto.

1. **`SUMMARY_SYSTEM` ganha duas seções verbatim.** Além dos oito headings
   originais (Active Task, Goal, ..., Remaining Work), agora pede `User
Asks, Verbatim` (cada pedido distinto, citado exatamente, nunca
   parafraseado) e `Constraints And Prohibitions, Verbatim` (cada restrição
   ou proibição, citada exatamente, nunca descartada como "não mais
   relevante"). Ganha também a regra de não-atribuição do `commands/compact.md`
   do Claude Code: texto formatado como `user: ...` **dentro de uma mensagem
   do assistente** é gerado pelo modelo, nunca deve ser atribuído ao usuário
   nas seções verbatim. E fecha com "respond with text only" (o resumo é
   sempre texto puro, nunca uma chamada de tool). O teste de contrato
   (`tests/client-pool-aux.test.ts`) verifica o TEXTO da constante, não só a
   referência — antes desta issue, um `expect.objectContaining({ content:
SUMMARY_SYSTEM })` prendia a constante contra si mesma e nunca pegaria uma
   regressão no próprio texto.

2. **`buildSummaryRequest`'s `maxTokens` deixa de ser fixo em 1024.**
   `summaryMaxTokens(foldedTokens)` calcula
   `clamp(1024, ceil(foldedTokens / 8), 4096)` a partir de uma estimativa
   (`estimateTokens`, `src/context/token-estimate.ts`) do próprio `transcript`
   que `buildSummaryRequest` recebe — nunca menor que antes (o piso é o valor
   antigo) e nunca maior que 4096 (o resumo é um meio de encolher o turno,
   não um segundo transcript). Calculado dentro da própria função, e não
   recebido como parâmetro externo, para que a assinatura de
   `buildSummaryRequest` e o único chamador de produção hoje (o summarizer
   default em `ConversationRuntime.runTurn`, `src/conversation/runtime.ts`,
   fora do `Files` desta issue) continuem exatamente como estão. Desde a
   issue #620, `summaryMaxTokens` (e o piso/teto/divisor) vive em
   `src/conversation/summary-budget.ts` — um módulo folha sem import de
   `compaction.ts` nem de `agent/aux.ts` — e `compaction.ts` reexporta os
   mesmos nomes; ver "Compactação pelo `AuxClient` usa o mesmo orçamento de
   saída (issue #620)" adiante.

3. **`buildTranscript` corta pela cauda quando o trecho excede um orçamento.**
   Um histórico dobrado muito acima da janela (por exemplo depois de um
   `LOHRA_CONTEXT_WINDOW` bem menor que o histórico real acumulado, ou uma
   sessão restaurada sob uma janela menor que a que a escreveu) fazia a
   própria chamada de resumo correr o risco de estourar a janela do
   provedor — a lacuna que a seção "Fora de escopo" acima documentava.
   Agora, `buildTranscript(messages, maxTokens)` estima o trecho inteiro e,
   se passar do orçamento, mantém a CABEÇA (onde vive um pedido ou proibição
   antigos — exatamente o que as novas seções verbatim mais precisam manter
   intacto) e corta a CAUDA (as mensagens mais recentes do trecho dobrado, já
   as mais próximas da cauda intocada que `attemptCompaction` preserva fora
   do fold) no limite de turno mais próximo (`headAlignedKeepCount`, o
   espelho de `turnAlignedTailCount` andando para frente) — nunca separa um
   pedido da própria resposta nem uma mensagem `tool_calls` dos seus
   resultados (issue #587 corrige um caso em que o fallback do próprio corte
   podia violar essa regra — ver a seção do #587 adiante). Devolve
   `{ transcript, truncated, droppedMessages }`; `attemptCompaction` repassa
   `truncated` como `transcriptTruncated` no `CompactionAttemptResult`. O
   orçamento default (`DEFAULT_TRANSCRIPT_TOKEN_BUDGET`, metade de
   `DEFAULT_CONTEXT_WINDOW`) é autocontido — só vale quando o chamador não
   passa `maxTranscriptTokens` explícito em `CompactionAttemptInput`; desde
   o #587, `ConversationRuntime` sempre passa a janela real (seção
   adiante).

`SUMMARY_LEAD_TEXT` (`src/state/session-repository.ts`) também muda de
português ("(resumo da conversa anterior a seguir)") para inglês
("(summary of the earlier conversation follows)"), para casar com o resto do
prompt (inglês). É texto **persistido**: só sessões compactadas a partir
deste commit ganham o lead novo — uma sessão já compactada antes continua
com o texto antigo na própria linha de `messages`, e `loadMessages`/
`reconstructMessage` nunca validam esse conteúdo contra a constante, então
ela carrega de volta byte a byte, sem quebrar (teste em
`tests/conversation-compaction-verbatim.test.ts`).

Fora de escopo desta issue (ver `#576` na tabela do épico #575): o caso de
eval "proibição sobrevive à compactação" com os dois oráculos —
`tests/fixtures/eval/**` e `scripts/eval/run.ts` ainda não existem em `main`
(#576, harness de eval, ainda não mergeado). Ligar o `AuxClient` de verdade
ao caminho de produção, incluindo levar a janela real do turno para dentro
de `attemptCompaction`, era o item pendente desta lista — a issue #587
fechou os dois (seção seguinte).

## Compactação e título pelo AuxClient (issue #587)

Fecha o ponto de injeção `options.summarize` que o #252 já previa e nunca
tinha chamador de produção, mais cinco itens de um veredito de revisão
sobre a #584 (PR #597):

1. **`chat.ts`/`dashboard.ts` constroem um `AuxClient`** a partir do
   `ClientPool` (mesmo provedor/cliente do turno, `defaultAuxModel` do
   perfil) e passam `summarize: aux.summarizer()` ao `ConversationRuntime` —
   ausente sem `defaultAuxModel`, byte-idêntico ao comportamento anterior.
   `dashboard.ts` só liga o `ConversationRuntime` que o próprio arquivo
   constrói (o job runner do cron); o caminho interativo da gateway WS
   (`src/gateway/ws/connection.ts`) constrói o seu por turno e fica fora do
   `Files` desta issue.
2. **Falha do auxiliar cai para o transporte do turno.** `runTurn` envolve
   `options.summarize` (quando presente) com `summarizeWithFallback`
   (`src/agent/aux.ts`): uma falha do `AuxClient` emite
   `"compaction.aux_fallback"` (o nome da causa em `code`) e usa o
   summarizer default do próprio turno — nunca derruba o turno inteiro por
   uma falha do auxiliar.
3. **`aux_calls` aditivo no envelope `--json`.** `AuxClient.auxTelemetry()`
   soma `calls`/`usage` de `summarize` e `title` num único contador —
   `aux_calls` conta as DUAS chamadas, não só o resumo, mas `2` no mesmo
   turno nunca acontece. Duas razões, uma atrás da outra: `attemptCompaction`
   (`runtime.ts:232`) só dobra o histórico já PERSISTIDO — relê da própria
   sessão (`repository.loadMessages`) e, se não sobrar nada além da cauda
   mínima a manter, devolve `compacted: false` sem resumir nada
   (`src/conversation/compaction.ts`, `summarizedCount <= 0`); e
   `preflightCompact` só tenta essa dobra UMA vez por turno
   (`context.compactedThisTurn`, `runtime.ts:222-229`) — a segunda
   estouração do mesmo turno vira `ContextWindowExceededError` direto,
   nunca uma segunda chamada a `attemptCompaction`. Na prática: numa sessão
   NOVA (sem `--session`) sem estourar a janela, `aux_calls` mostra `1` (só
   o título, issue #623); numa sessão NOVA cujo turno estouraria a janela,
   não há histórico persistido para dobrar (é a primeira sessão) — o turno
   falha com `ContextWindowExceededError` antes de completar, nunca chega a
   reportar `aux_calls`; numa sessão RETOMADA (`--session` dado) que
   compacta (há histórico persistido de turnos anteriores para dobrar),
   `aux_calls` mostra `1` (só o resumo — a sessão já tem título ou nunca
   ganha um por essa via, já que `AuxClient.title()` só roda para uma sessão
   que este `chat.ts` acabou de criar). `chat.ts` lê isso após `runTurn` (e,
   desde a #623, também antes —
   ver item 4) e passa a `successEnvelope(result, { auxCalls, auxUsage })` —
   `usage_total` soma o uso do auxiliar (`addUsage`, módulo folha
   `src/conversation/usage.ts` desde a #650 — antes vivia em `runtime.ts`)
   e `aux_calls` só aparece quando > 0, sempre ao final, nunca mudando
   ordem/contagem das chaves existentes. Desde a #650, `errorEnvelope`
   aceita o mesmo `extra` — ver a seção "Envelope de erro carrega o gasto
   do auxiliar" mais abaixo.
4. **Título persistido.** `title TEXT` já existia no schema base (sem
   migração); `SessionRepository.setTitle` grava o texto de
   `AuxClient.title()` numa sessão nova (sem `--session`), fail-open com
   evento `title.failed` em stderr; `session_search` modo `browse` já
   devolve o título porque `SessionSearchTool` repassa
   `SearchRepository.listSessions()` verbatim. Issue #623: o título é gerado
   ANTES de `runtime.runTurn` (a partir do mesmo `input` que `result.input`
   ecoaria) e persistido só depois de `result.sessionId` existir — ver a
   seção seguinte para o porquê.
5. **Acréscimo do orquestrador** (veredito da PR #597/#584):
   `maxTranscriptTokens` passado a `attemptCompaction` agora vem de
   `Math.floor(resolution.tokens * TRANSCRIPT_WINDOW_FRACTION)` — a janela
   REAL do perfil, não mais o default inerte de `compaction.ts`;
   `buildTranscript` perdeu o `console.warn` hardcoded, e
   `transcriptTruncated` ganhou consumidor de verdade
   (`"compaction.transcript_truncated"`, emitido por `preflightCompact`
   através do mesmo `eventSink` injetável de sempre); `headAlignedKeepCount`
   tinha um bug real — o corte por budget podia manter uma mensagem
   `assistant` com `tool_calls` sem manter seu `tool` correspondente (o
   backward scan nunca examinava o índice 0) — corrigido com um fallback
   seguro ("manter nada"), simétrico ao "manter tudo" de
   `turnAlignedTailCount`; e `src/agent/aux.ts` ganhou mutante na fatia
   `mutations:t23` (`docs/mutation-testing.md`), que antes não cobria
   nenhum arquivo de `src/agent/`.

## Compactação pelo `AuxClient` usa o mesmo orçamento de saída (issue #620)

Achado do veredito da PR #617 (#587): a #584 fez `buildSummaryRequest`
calcular `summaryMaxTokens(foldedTokens)` em vez de um `maxTokens` fixo em
1024, mas `AuxClient.summarize`/`AuxTelemetry.summarize` (o caminho que um
perfil com `defaultAuxModel` usa desde a #587) continuavam chamando
`completeWithUsage` com o default `maxTokens = 1024`, qualquer que fosse o
tamanho do fold — nos oito perfis com `defaultAuxModel` (anthropic, openai,
deepseek, groq, glm, kimi e os dois via Codex), um fold grande truncava
exatamente as duas seções verbatim que a #584 existe para preservar.

`summaryMaxTokens` (e `SUMMARY_MAX_TOKENS_FLOOR`/`_CEILING`/`_DIVISOR`, issue
#584) move para `src/conversation/summary-budget.ts` — um módulo folha sem
import de `compaction.ts` nem de `agent/aux.ts` (`compaction.ts` já importa
`SUMMARY_SYSTEM` de `aux.ts`; o caminho inverso ciclaria) — importado por
`compaction.ts` (que reexporta os mesmos nomes, byte-idênticos para todo
chamador/teste existente) e por `AuxClient`. `AuxClient.summarize`
(`summarizer()`, o injetado em `ConversationRuntime.options.summarize`) e
`AuxTelemetry.summarize` passam a chamar
`summaryMaxTokens(estimateTokens([{ role: "user", content: transcript }])
.tokens)` — a mesma forma que `buildSummaryRequest` estima, então os dois
caminhos concordam no mesmo número para o mesmo transcript, com ou sem
`defaultAuxModel` configurado no perfil.

Dois pinos menores do mesmo veredito, sem mudança de comportamento:
`tests/conversation-compaction-verbatim.test.ts` repõe o spy de
`console.warn`/`console.error` que prendia `buildTranscript` nunca
escrevendo no console — perdido quando a #587 removeu o `console.warn`
hardcoded (item 5 da seção anterior) sem repor o pino em si; e
`tests/chat-compaction-events.test.ts` pina `aux_calls` ponta a ponta contra
`chat.ts` (com um perfil de `defaultAuxModel` não vazio contra o mesmo
servidor HTTP local, sem crédito real) para o caso de sessão RETOMADA
(`--session` dado, `aux_calls: 1`). O caso de sessão NOVA ficou documentado
como bloqueado por um bug pré-existente até a #623 (seção seguinte).

## Título de sessão nova via AuxClient roda antes do transporte fechar (issue #623)

`ConversationRuntime.runTurn`'s próprio `finally` fecha o `modelTransport`
incondicionalmente (`src/conversation/runtime.ts:792`), o que fecha o
`client` subjacente que `chat.ts` também passa ao `AuxClient`
(`src/commands/chat.ts:371-390`). Antes desta issue, `AuxClient.title()`
(alcançado só numa sessão nova, sem `--session`) rodava DEPOIS que `runTurn`
retornava, contra um client já fechado, e sempre lançava `CLIENT_CLOSED` —
engolido pelo `catch` fail-open de `chat.ts` (evento `title.failed`).
Nenhuma sessão nova com `defaultAuxModel` configurado jamais ganhava título
em produção; `aux_calls` nunca contava a chamada do título. Diagnosticado no
comentário da issue #620.

Correção: `chat.ts` gera o título ANTES de chamar `runtime.runTurn`, a
partir do mesmo `input` que `result.input` ecoa (`runtime.ts:734` — os dois
são sempre o mesmo texto) — o transporte ainda está aberto nesse ponto. A
persistência (`sessions.setTitle`) continua só depois de `result.sessionId`
existir (o id que `runTurn` acabou de criar via `idSource`/`createSession`),
com seu próprio `try`/`catch` fail-open: uma falha de escrita no `state.db`
não transforma um turno bem-sucedido numa resposta de erro. O caminho de
falha real do auxiliar continua fail-open com o mesmo evento nomeado
(`title.failed`) nos dois pontos (geração e persistência) — nunca deixando
de terminar o turno.

Tradeoff aceito: a chamada ao auxiliar agora roda sequencialmente ANTES do
turno (não concorrente com ele) numa sessão nova com `defaultAuxModel` —
mais uma ida-e-volta de rede antes do turno começar, perceptível no modo
interativo. A alternativa (opção 2 do corpo da issue: envolver o
`modelTransport` com um `NonClosingTransport` e fechar o `client`
explicitamente no `finally` de `runChat`) exigiria provar que o client
fecha exatamente uma vez em todo caminho (sucesso, erro, abort) sem tocar
`runtime.ts` nem reabrir a questão de quem é dono do ciclo de vida do
client compartilhado com o `ClientPool` — descartada em favor da correção
mais simples.

`tests/chat-compaction-events.test.ts` ganhou dois testes: o caminho feliz
de sessão nova (`aux_calls: 1`, título persistido, sem `title.failed` no
stderr) e o caminho de falha real do título (fixture que derruba só a
chamada de 32 tokens do título — `AuxClient.title()` é a única chamada com
esse `max_tokens` — mantendo o turno em `code: 0`, `aux_calls: 0`, título
`null` e `title.failed` no stderr).

## Envelope de erro carrega o gasto do auxiliar; `title.failed` nomeia o estágio (issue #650)

Item 13 do épico #637 (grupo B), veredito da PR #625 (`non_blocking` 2,
"gasto órfão no caminho de erro"): antes desta issue, um turno que falhava
depois de um título gerado com sucesso (perfil com `defaultAuxModel`, sessão
nova) perdia esse gasto auxiliar inteiro — `errorEnvelope` não tinha
parâmetro `extra` nenhum. Hoje o call site (`src/commands/chat.ts:595-622`)
constrói o envelope de erro com os campos do turno e, como segundo
argumento, o `extra` aditivo descrito abaixo.

`errorEnvelope` ganha o mesmo segundo parâmetro `extra?: AuxEnvelopeExtra`
que `successEnvelope` já tinha desde a #587 (`src/conversation/envelope.ts:151,163,175`):
`usage_total` soma `extra.auxUsage` via `addUsage`, e `aux_calls` só aparece
quando `> 0`, sempre como a última chave — sem `extra` (ou com `auxCalls: 0`),
o envelope fica byte-idêntico ao de antes da issue, mesma contagem de
`Object.keys`. `chat.ts` passa `{ auxCalls: auxTelemetry.calls(), auxUsage:
auxTelemetry.usage() }` quando `auxTelemetry` existe (`src/commands/chat.ts:619-621`).

`addUsage` — usado pelos dois envelopes e por `ConversationRuntime` — deixa
de morar em `runtime.ts` (que o exportava desde a #587) e de ter uma cópia
duplicada em `aux.ts` (`aux.ts:52-66` antes desta issue, com um comentário
explicando por que não podia importar de `runtime.ts` sem ciclo): as duas
viram um módulo folha, `src/conversation/usage.ts`, sem import de nenhuma
das duas — `runtime.ts`, `aux.ts` e `envelope.ts` importam dali.
`src/conversation/index.ts` reexporta o módulo.

`title.failed` (stderr, evento fail-open da issue #623) passa a nomear qual
dos dois pontos falhou — mesmo prefixo fixo, então nenhum pino antigo por
substring quebra: `title.failed stage=generate` quando a própria chamada do
título falha (`src/commands/chat.ts:542-548`, nunca chega a persistir), e
`title.failed stage=persist` quando o título foi gerado mas
`sessions.setTitle` lança na escrita (`src/commands/chat.ts:569-571`).

`ConversationCancelledError` ganha `partialCalls: number` (default `0`),
espelhando `MaxIterationsError.partialCalls` (issue #594,
`src/conversation/errors.ts:152,160,170`): quantas chamadas deste turno já
tinham sido derrubadas por um steer-driven interrupt e absorvidas com
`continue` antes deste cancelamento em voo. Só um call site passa o contador
de verdade — o cancelamento em voo dentro do loop de iteração
(`src/conversation/runtime.ts:513-527`); os dois throws pré-emissão do mesmo
arquivo (`runtime.ts:423` e `runtime.ts:459`, sinal já abortado antes da
chamada existir) ficam no default `0`, porque nenhuma chamada desta iteração
chegou a ser emitida. `child-runner.ts` não lê este campo — `partial`/
`usage_uncertain` ali continuam derivando só de `partialUsage !== null`
(ver `docs/workflow-supervision.md`); `partialCalls` é dado adicional para
quem quiser distinguir "cancelado depois de N chamadas reais" de "cancelado
antes da primeira", não uma entrada nova nesse contrato existente.

Mutante novo (o primeiro em `envelope.ts`) documentado em
`docs/mutation-testing.md`.
