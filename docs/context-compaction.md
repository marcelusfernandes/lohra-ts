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
`docs.../session-service.ts`, ADR-T12-04).

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
submissível no gateway quanto antes (`tests/gateway/session-service.test.ts`,
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
     seu resultado, e que o resumo (inserido como `assistant`) é sempre
     seguido por `user`.
   - Se não sobrar nada para resumir, devolve "nada compactado" (o caso
     fútil).
   - Caso contrário, resume o trecho antigo com o **transporte do próprio
     turno** (mesmo modelo, prompt `SUMMARY_SYSTEM` de `src/agent/aux.ts`;
     `options.summarize` pode injetar outro summarizer, por exemplo um
     `AuxClient.summarizer()` futuro) e chama
     `SessionRepository.compactHistory`, que reescreve tudo numa transação:
     desativa as mensagens antigas, insere o resumo, e **reinsere** as
     mensagens preservadas com ids novos — preservar os ids antigos faria o
     resumo (id mais alto, por ser o mais recente) ficar **depois** delas
     em `loadMessages` (que ordena por `id`), invertendo a ordem.
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
o protocolo de eventos que uma TUI/GUI futura consome (ainda sem emissor
ligado, como o resto desse protocolo hoje). `ConversationTurnResult.compaction`
carrega o mesmo resumo quando uma compactação rodou no turno; `successEnvelope`
inclui a chave `compaction` só nesse caso (ausente, nunca `null`, quando não
rodou — as fixtures de `tests/conversation-envelope.test.ts` que nunca
passam esse campo mantêm a mesma contagem de chaves).

## Fora de escopo desta issue

- Compactação de folhas de workflow (issue #252, seção "Fora de escopo").
- Um summarizer dedicado com modelo/preço próprios (`AuxClient`,
  `src/agent/aux.ts`) — o caminho default reaproveita o transporte do
  próprio turno; `options.summarize` é o ponto de injeção para quem quiser
  ligar isso depois, sem mudar `commands/chat.ts`.
- Cache do catálogo (`loadWindowsCache`, #249) na resolução da janela
  dentro do preflight — `resolveTurnContextWindow` passa `catalog: undefined`
  de propósito, então a resolução aqui nunca sobe além de `table`/`provider`/
  `default`/`override`; ligar o catálogo é trabalho futuro, não regressão
  desta issue.
