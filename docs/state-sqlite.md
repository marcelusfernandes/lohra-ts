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

## Referências

- `src/state/connection.ts:93-154`
- `src/state/audit-repository.ts:136-148`
- `src/workflow/audit-trail.ts:252-273`
