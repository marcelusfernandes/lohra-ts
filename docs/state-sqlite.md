# SQLite: busy_timeout e detecção de contenção

Comportamento de `src/state/connection.ts` e `src/state/audit-repository.ts`
na conexão única aberta por `openStateDatabase`/`openStateForEnvironment`
(issue #235).

## `busy_timeout`

`openStateDatabase` pina `database.pragma("busy_timeout = ...")` na abertura
da conexão, antes de aplicar o schema. O padrão é **5000ms**.

`LOHRA_SQLITE_BUSY_TIMEOUT_MS` sobrepõe o padrão: precisa ser um inteiro
decimal `>= 0` (`0` é válido — desliga o busy handler do driver). Qualquer
outro valor — negativo, fracionário, notação científica (`1e3`), texto,
string vazia ou só espaços — levanta `StateError` com `code =
"SQLITE_BUSY_TIMEOUT_INVALID"` na abertura da conexão; o valor nunca é
ignorado em silêncio.

```
LOHRA_SQLITE_BUSY_TIMEOUT_MS=250   # válido: busy_timeout = 250
LOHRA_SQLITE_BUSY_TIMEOUT_MS=-1    # StateError: SQLITE_BUSY_TIMEOUT_INVALID
LOHRA_SQLITE_BUSY_TIMEOUT_MS=abc   # StateError: SQLITE_BUSY_TIMEOUT_INVALID
```

`openStateForEnvironment(environment, options)` lê a variável do mesmo
`environment` usado para resolver `stateDatabasePath` (ver `LOHRA_HOME` e
`LOHRA_PROFILE`), a menos que `options.environment` seja passado explicitamente
(uso de teste, para isolar do processo real). `openStateDatabase(path,
options)` sem `options.environment` cai para `process.env`.

## Detecção de BUSY

`AuditRepository` usa `isBusyError(error)` (chamado pelo retry de
`AuditTrail`, `src/workflow/audit-trail.ts:252-273`) para decidir se vale a
pena tentar de novo. A checagem prioriza o código que o driver
(`better-sqlite3`) anexa ao erro:

1. **`error.code` presente e é `SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY` ou
   `SQLITE_BUSY_SNAPSHOT`** → contenção, `true`. São os três códigos que o
   SQLite deriva de `SQLITE_BUSY` (`deps/sqlite3/sqlite3.h` dentro de
   `node_modules/better-sqlite3`); o timeout expirando surge como
   `SQLITE_BUSY` puro.
2. **`error.code` presente mas fora desse conjunto** → decide sozinho,
   `false`. Um código "estranho" nunca cai para o texto — evita que uma
   mensagem que por acaso contenha "busy" mascare um erro de outra natureza
   (ex.: `SQLITE_CONSTRAINT`).
3. **Sem `error.code`** (erro genérico, sem driver por trás) → fallback para
   o texto histórico, `/database is (?:locked|busy)/i` contra
   `error.message`.

## Migrações aditivas (`addedColumns`)

`src/state/schema.ts` mantém `addedColumns` — uma lista `[tabela, coluna,
declaração]` aplicada por `addMissingColumns` (`src/state/connection.ts:68-76`)
a cada abertura: um `ALTER TABLE <tabela> ADD COLUMN <coluna> <declaração>`
por entrada, engolindo só o erro `duplicate column name` (banco que já tem a
coluna — idempotente); qualquer outro erro de `ALTER TABLE` propaga
(fail-closed), nunca é silenciado.

Algumas entradas de `addedColumns` já estão embutidas em `applicationSchema`
(a tabela nasce com a coluna desde a issue que a introduziu) — a entrada
sobrevive só para migrar um banco criado ANTES disso. Outras nunca entraram
na DDL crua e dependem só do `ALTER TABLE` para existir em qualquer banco.

`tests/state-migrations.test.ts` (issue #481) é o contrato durável dessa
migração: um `it` por entrada REAL de `addedColumns`, cada um abrindo um
banco criado SEM aquela coluna (a DDL completa, com a coluna removida via
`ALTER TABLE ... DROP COLUMN` quando ela já vier embutida) por
`openStateDatabase` do HEAD e afirmando a coluna e o tipo declarado via
`PRAGMA table_info` — nunca um banco que o próprio HEAD já cria completo, o
que mascararia uma migração quebrada. Um caso adicional cobre o fail-closed:
uma tabela substituída por uma view do mesmo nome faz o `ALTER TABLE` falhar
com um erro que não é `duplicate column name`, e o teste confere que ele
propaga em vez de ser engolido.

## `operator_notices`

Avisos ao operador com escopo (`run:<run_id>` ou `global`), dono e ack —
irmão de `workflow_audit_events`/`AuditRepository`, mas para "isto aconteceu
e alguém precisa ver", não para a trilha de execução (issue #400/M8-4).

Duas tabelas: `operator_notices` (`id` autoincrement, `scope`, `seq`
monotônico por escopo, `kind`, `message`, `created_at`, `acked_at`/
`acked_by` nulos até o ack, `fence` — nulo para `global`; `UNIQUE(scope,
seq)`) e `operator_notices_state` (`scope` como chave, `next_seq`,
`retention_dropped`, `dropped_before_seq`, `updated_at`) — o mesmo desenho
de `workflow_audit_state`.

`src/state/notices-repository.ts` (`NoticesRepository`):

- **`kind`** é validado contra `NOTICE_KINDS = [...ERROR_KINDS,
...STATE_NOTICE_KINDS]` (`notices-repository.ts:18-25`, issue #401/M8-5):
  os 9 `ErrorKind` de `src/transports/error-kinds.ts` (issue #397) mais
  `stale_fence_write`, `audit_sink_failure`, `resume_attempts_exhausted`,
  `queue_overflow` — um vocabulário único em vez de duas listas que podiam
  divergir. Fora dele → recusa nomeada via `warning`, `append` devolve
  `null`, nunca grava, nunca lança.
- **Fence**: `append(scope, {kind, message}, ownership?)` com `scope =
"run:<id>"` exige `ownership` e aplica o MESMO predicado de dono de
  `audit-repository.ts:196-200` (JOIN `workflow_run_fence`/
  `workflow_run_locks` por `fence`/`holder`/`expires_at`) — sem `ownership`
  nesse escopo, recusa. Fence velho ou dono errado → `append` devolve
  `null`, um `refused_writes` a mais (contado por escopo, LRU até
  `maxScopes`) e um único `warning` (nunca dois logs pela mesma recusa,
  mesma decisão da #380 para `AuditRepository`). `scope = "global"` grava
  sem `ownership` — usado tanto para avisos de processo sem run associado
  quanto, desde #410 (bullet abaixo), como destino de fallback para um aviso
  `run:<id>` sem dono válido (a mensagem carrega o `run_id` em texto mesmo
  sob escopo `global`) — `fence` fica `null` na linha em ambos os casos.
- **Fallback sem dono** (issue #410/M8-8): `createNoticesSink.warnState`
  (`src/workflow/notices-sink.ts`) nunca descarta um `STALE_FENCE_WRITE` só
  porque este processo não tem `ownership` válida do run — sem lease, ou
  lease que outro processo já tomou — grava a mesma notice em `scope:
"global"` em vez de perder o aviso; `dropped` fica reservado para uma
  escrita em `global` que falhe por si.
- **`message`** truncada em 2 KiB (`Buffer.byteLength` em UTF-8, nunca corta
  no meio de um caractere multi-byte) com o marcador `…[truncated]`.
- **`list({scope?, afterSeq?, includeAcked?, limit?})`** → `{notices,
next_after_seq, has_more, refused_writes, dropped_before_seq?}`. Por
  padrão omite reconhecidos; `includeAcked: true` os mostra, com
  `acked_at`/`acked_by`. `afterSeq`/`next_after_seq` só fazem sentido POR
  ESCOPO (`seq` é monotônico por `scope`, não global) — sem `scope`, a
  listagem cruza escopos ordenada por `id`, `next_after_seq` vem `0` e
  `dropped_before_seq` fica ausente (a retenção é por escopo).
  `refused_writes` sem `scope` soma todos os escopos conhecidos.
- **`ack(id, actor, now?)`** é idempotente: `true` na primeira vez, `false`
  se já reconhecido ou se `id` não existe — nunca lança.
- **Retenção** (`maxPerScope`, padrão `NOTICES_SCOPE_CAP = 256`): acima do
  teto, os avisos RECONHECIDOS caem primeiro (mais antigos entre eles
  primeiro); um não-reconhecido só cai quando não sobra nenhum reconhecido
  para cair no lugar — `ORDER BY (acked_at IS NULL) ASC, seq ASC` no
  `DELETE`. `dropped_before_seq` registra o maior `seq` já descartado
  daquele escopo (avisos com `seq` menor ou igual podem estar faltando).

Esta seção é só a tabela e o repositório (`NoticesRepository`). O sink de
produção que grava aqui (`createNoticesSink`, um por processo), o mapa de
`kind` por substring, as duas tools (`workflow_notices`/
`workflow_notices_ack`) e `lohra workflow notices` — issues #401/#402
(M8-5/M8-6) — estão em `docs/operator-notices.md`.

## `workflow_node_cache.identity_version`: carimbo, nunca chave (#461, M11-S3)

`identity_version` é uma coluna `TEXT` adicionada a `workflow_node_cache`
por `addedColumns` (`src/state/schema.ts:149`, aplicada por
`addMissingColumns` em toda abertura de conexão — um `ALTER TABLE ... ADD
COLUMN` que ignora silenciosamente só o erro "duplicate column name",
`src/state/connection.ts:68-75`) — o mesmo mecanismo que já adicionou as
outras colunas da lista, nunca uma migração versionada à parte.

- **Nunca faz parte da chave de lookup** (`content_hash`/`run_id`) —
  `CELL_IDENTITY_VERSION` (`src/workflow/cache.ts:38`, hoje `"1"`) só
  CARIMBA a célula na escrita, na MESMA transação do INSERT da célula
  (`putCacheCellWithCost`, `src/state/workflow-repository.ts:256-319`,
  o carimbo em si `:274-283`),
  nunca entra no hash que decide se uma célula é a mesma.
  `CELL_IDENTITY_VERSION` só sobe quando as PARTES que uma célula hasheia
  mudam (`runAgent`/`runParallel`/... em `engine.ts`,
  `loopCellParts`/`replayOrCollectBranch`/... em `engine-utils.ts`) — nunca
  numa migração de schema nem num release de rotina; o bump vive na MESMA
  PR que a mudança, pinado por `tests/workflow-cache-stamp.test.ts`.
- **Marca, nunca invalida** — decisão 3 do épico #458 (comentário do
  orquestrador na issue #458, 2026-09-12): a alternativa "chave versionada"
  do enunciado do milestone (um bump invalidaria TODO cache durável) foi
  registrada como rejeitada; o carimbo é coerente com "custo, não
  corrupção" (`docs/decisions/2026-09-10-cache-escopo-irmaos.md`, seção
  "Consequência para bancos existentes") e com o precedente do Python #75
  ("marcar, nunca invalidar"), citados pelo próprio comentário da decisão.
  Detalhe completo em
  [`docs/decisions/2026-09-13-carimbo-da-celula.md`](decisions/2026-09-13-carimbo-da-celula.md).
- **Leitura** (`SqliteWorkflowCache.lookup`, `src/workflow/sqlite-cache.ts:48-99`,
  com `SELECT` próprio contra `workflow_node_cache`; a mesma coluna também
  volta por `WorkflowRepository.getCacheCell`,
  `src/state/workflow-repository.ts:199-212`, usado fora do caminho de
  cache) classifica um HIT em `versionState`: `current` (carimbo bate com
  `CELL_IDENTITY_VERSION`), `stale` (carimbo presente mas DIFERENTE — a
  identidade da célula mudou desde que foi escrita, tipicamente um pivô de
  rota) ou `unstamped` (`NULL` — célula gravada antes desta coluna
  existir). O replay acontece EXATAMENTE igual nos três casos — só a
  classificação muda; `version_state` chega ao ledger via
  `cache.replayed` (`docs/workflow-audit.md`). `MemoryWorkflowCache`
  (`src/workflow/cache.ts`) nunca reporta `unstamped` — só tem células da
  vida do processo, todas carimbadas — só `current`/`stale`.
- **`node_id` da célula passa a ESCOPADO** (`scopedCheckpointId`,
  `<workflowNodeId>.<innerNodeId>` dentro de um nó `workflow` aninhado):
  antes de #461 a coluna física guardava o id CRU do nó (`engine.ts`'s
  `cachePut`), enquanto `cacheGet`/`nodeCosts` já usavam a forma escopada
  desde #348 — a mesma inconsistência que fazia `hasCellForNode` (miss
  classification) e a coluna da célula divergirem para um nó dentro de um
  `workflow` aninhado. Hoje as duas leem/escrevem a MESMA forma escopada.

## Referências

- `src/state/connection.ts:93-154`
- `src/state/audit-repository.ts:136-148`
- `src/workflow/audit-trail.ts:252-273`
- `src/state/notices-repository.ts`
- `src/state/schema.ts` (`addedColumns`), `src/state/connection.ts:68-76`
  (`addMissingColumns`)
- `tests/state-migrations.test.ts`
