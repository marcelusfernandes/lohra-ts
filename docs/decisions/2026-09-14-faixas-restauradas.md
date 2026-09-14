# Sessão retomada: as faixas persistidas SÃO o prompt congelado

- **Data:** 2026-09-14
- **Origem:** issue #649 (sub-issue B1 de #637, grupo B itens 9-10;
  vereditos PR #621 e PR #610); limite documentado por #624/PR #628 em
  `docs/system-prompt.md:590-614` (reescrita pelo `documentador` pós-merge,
  fora do `Files` desta issue).

## Contexto

`src/conversation/runtime.ts` (agora `runtime-session.ts`, extraído por
esta issue) resolvia a sessão de um turno em três casos: sessão explícita
ausente (`SESSION_NOT_FOUND`), sessão nova (`promptSnapshot()` +
`createSession` com as três faixas) e sessão retomada. No terceiro caso, o
código anterior a esta issue **descartava** as faixas que
`repository.session(id)` acabara de restaurar do banco e as substituía pela
closure `promptSnapshot()` deste processo (`runtime.ts:351` antes desta
issue). As três colunas `system_prompt_*` que a #586 passou a persistir
(`src/conversation/sqlite-repository.ts:56-64`) não alimentavam nenhum
request de sessão retomada — "persistência meia-eficaz" no veredito da
PR #621. O item 10 do veredito da PR #610 via o mesmo mecanismo do outro
lado: "`runtime.ts:363` reconstrói o system prompt a cada turno de sessão
existente → sessão pré-#579 ganha a doutrina ao retomar" — a reconstrução é
que quebra o invariante 1 (CLAUDE.md: "system prompt construído uma vez por
sessão e congelado"), não a ausência de doutrina numa sessão que nasceu sem
ela.

`promptSnapshot()` já é memoizada por instância (`this.prompt ??= ...`) —
o invariante 1 valia DENTRO de um processo antes desta issue. A divergência
só existe ENTRE processos: `chat --session <id>` num binário novo, ou o
mesmo id retomado pelo WS do dashboard com uma closure diferente.

## Decisão

Sessão retomada com `volatile !== ""` (o discriminador: `systemPromptBands`
sempre anexa `Today's date is ...` à faixa `volatile` quando entendeu
faixas de verdade — `src/context/system-prompt.ts:151`, comentado em
`resolveTurnSession`) usa as três faixas restauradas do repositório,
BYTE-IDÊNTICAS, e nunca chama `promptSnapshot()`. Uma linha migrada
(`context === "" && volatile === ""` — pré-#586, ou `createSession`
chamado com uma string simples) continua caindo em `promptSnapshot()` como
antes desta issue: não há faixas de verdade para reusar.

Três consequências nomeadas, não implícitas:

1. **A data em `volatile` fica congelada na criação da sessão.** Visível ao
   usuário: uma sessão retomada dias depois ainda diz "Today's date is
   <data de quando nasceu>" — coerente com a nota de ambiente já existente
   ("Snapshot taken at session start; it does not update during the
   conversation", `system-prompt.ts:31-32`), mas agora também verdade
   ENTRE processos, não só dentro de um.
2. **Memória e skills gravadas depois da criação da sessão não entram no
   prompt de uma sessão retomada.** É exatamente o que o invariante 1
   prescreve — "memória/skills mudam disco, nunca o prompt vivo" — e não um
   efeito colateral indesejado.
3. **Uma sessão criada sem doutrina (perfil "fraco", `LOHRA_DOCTRINE=core`,
   ou uma sessão pré-#579) continua sem doutrina ao ser retomada num
   binário que já a tem disponível.** O item 10 do veredito da PR #610
   fecha por construção, não por um caso especial.

### Por que não recomputar `volatile` sozinha

A alternativa considerada (reusar só `stable`+`context`, a parte que o
cache de prefixo do provedor de fato protege, e recomputar `volatile` toda
vez para a data ficar fresca) foi descartada: quebraria o invariante 1 pela
metade — o prompt deixaria de ser "construído uma vez e congelado" para
virar "construído uma vez, exceto a parte que muda". Se o owner preferir
essa leitura no futuro, é uma mudança de comportamento explícita contra
esta nota, não uma correção de bug.

## Doutrina para autores de spec

Uma sessão é a unidade de congelamento do prompt, não o processo. Uma
integração que precisa que uma sessão existente "veja" uma mudança de
doutrina, memória ou skill precisa criar uma sessão nova — retomar a mesma
`sessionId` nunca traz essas mudanças, propositalmente.

## Evidência

- `tests/conversation-runtime-prompt-caching.test.ts` (describe "reuses
  restored session bands on resume (#649)"): faixas restauradas (A) vencem
  sobre `promptSnapshot()` deste processo (B) quando `volatile !== ""`; uma
  linha migrada cai em `promptSnapshot()`; sessão nova inalterada.
- `tests/conversation-runtime-session.test.ts`: `resolveTurnSession`
  isolada — sessão nova, `SESSION_NOT_FOUND` só para id explícito ausente,
  faixas restauradas nunca chamam `promptSnapshot()`, fallback para linha
  migrada e para `systemPrompt` string simples (pré-#586).
- `tests/conversation-sqlite-prompt-caching.test.ts` (describe "resumed
  across two processes reuses P1 (#649)"): um segundo `ConversationRuntime`
  sobre a MESMA `SqliteConversationRepository` (processo novo simulado) usa
  a data e a doutrina de P1, nunca as de P2 — ambas as consequências (1) e
  (3) pinadas contra um round-trip real de SQLite.
- `scripts/mutations/context-window.ts`, mutante `aa-resumed-session-bands-
recomputed`: reverte a regra para "sempre `promptSnapshot()`"; morto por
  `tests/conversation-runtime-prompt-caching.test.ts`.
