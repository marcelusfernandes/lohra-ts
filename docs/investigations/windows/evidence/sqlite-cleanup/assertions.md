# Resultado observado, sem paths de usuário

Comando do corpus em [probes.md](probes.md), `--maxWorkers=2`. O clone histórico `fa8aa4a` saiu 1 nos Nodes 20.20.2 e 22.23.2: `Test Files 1 failed | 6 passed (7); Tests 2 failed | 87 passed (89)`. Em ambos, as mesmas falhas surgiram como `EBUSY: resource busy or locked, unlink '<TEMP>/lohra-service-sandbox-*/state.db'` em `tests/workflow-service-durability.test.ts:1460,2193` e de novo no `afterEach` em `:33`. O subconjunto com `-t` dos dois títulos saiu 1 em Node 20: 2 falhas, 32 casos filtrados, sem outra suíte concorrente.

No clone histórico temporariamente instrumentado, `connection.close()` foi garantido no `finally` **antes** de `rmSync` só nesses dois casos. O mesmo subconjunto saiu 1 por estas asserções primárias, sem `EBUSY`, em Node 20 e Node 22:

```text
tests/workflow-service-durability.test.ts:1424
step "inside-working-root": esperado "allowed:write_file"
observado "ERROR: path is outside the workflow working scope (sandbox denied)"
step "ro-root-read": esperado "allowed:read_file"
observado "ERROR: path is outside the workflow working scope (sandbox denied)"

tests/workflow-service-durability.test.ts:2188
esperado "allowed:write_file"
observado "ERROR: path is outside the workflow working scope (sandbox denied)"
```

No segundo caso, a asserção original interrompeu o teste antes de `openSecond()`/`await service.status(...)`; ao fechar a conexão no `finally`, o serviço ainda ativo também registrou faults de conexão fechada. Esses faults são consequência do experimento de desmascaramento, não um segundo motivo comprovado para o `EBUSY` original. A correção de fixture deve encerrar/aguardar atividade pendente antes de fechar a conexão ao tratar essa falha, preservando a asserção como causa primária.

No probe SQLite independente, cada Node produziu exit 0 e o mesmo resultado:

```json
{
  "platform": "win32",
  "arch": "x64",
  "openBefore": true,
  "beforeCode": "EBUSY",
  "openAfter": false,
  "removed": true
}
```

No clone `fa8aa4a` com somente `src/workflow/sandbox.ts` de `d39b99f`, e no HEAD atual `364a781`, o corpus original saiu 0: sete arquivos e 89 testes passaram em Node 20 e 22. Essa intervenção não alterou o teste nem a conexão SQLite.
