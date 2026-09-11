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

- **`kind`** é validado contra `NOTICE_KINDS`, vocabulário FECHADO local (os
  9 kinds da issue #397 mais `stale_fence_write`, `audit_sink_failure`,
  `resume_attempts_exhausted`, `queue_overflow`; a unificação com
  `src/transports/error-kinds.ts` é a issue #401/M8-5). Fora do vocabulário
  → recusa nomeada via `warning`, `append` devolve `null`, nunca grava, nunca
  lança.
- **Fence**: `append(scope, {kind, message}, ownership?)` com `scope =
"run:<id>"` exige `ownership` e aplica o MESMO predicado de dono de
  `audit-repository.ts:196-200` (JOIN `workflow_run_fence`/
  `workflow_run_locks` por `fence`/`holder`/`expires_at`) — sem `ownership`
  nesse escopo, recusa. Fence velho ou dono errado → `append` devolve
  `null`, um `refused_writes` a mais (contado por escopo, LRU até
  `maxScopes`) e um único `warning` (nunca dois logs pela mesma recusa,
  mesma decisão da #380 para `AuditRepository`). `scope = "global"` grava
  sem `ownership` (avisos de processo, sem run associado) — `fence` fica
  `null` na linha.
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

Fora de escopo aqui: ligar os sinks de produção (`src/workflow/*`) a esta
tabela e as tools/CLI de leitura — issues #401 e #402 (M8-5/M8-6).

## Referências

- `src/state/connection.ts:93-154`
- `src/state/audit-repository.ts:136-148`
- `src/workflow/audit-trail.ts:252-273`
- `src/state/notices-repository.ts`
