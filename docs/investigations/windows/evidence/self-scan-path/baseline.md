# Baseline de #825 — Windows 11 x64

Base `5500e3bf13f5f13245466f8303a07a2c353614c5`; clones descartáveis
separados por ABI em F:, com HOME, LOHRA_HOME, CODEX_HOME, TEMP e cache npm
isolados. `npm ci --no-audit --no-fund` saiu 0 em ambos. A sonda executa apenas
Vitest sobre `tests/sem-python.test.ts`; nenhum Python foi executado.

| Node    | Comando focal                                                    | Exit | Resultado na base    |
| ------- | ---------------------------------------------------------------- | ---: | -------------------- |
| 20.20.2 | `npm exec -- vitest run tests/sem-python.test.ts --maxWorkers=1` |    1 | 1 passou; 2 falharam |
| 22.23.2 | Mesmo comando                                                    |    1 | 1 passou; 2 falharam |

Os dois erros são do próprio arquivo `tests/sem-python.test.ts`: o teste de
literais acrescenta esse caminho à allowlist esperada de quatro arquivos, e
o teste de identificadores registra nele `runPythonProcess`,
`pythonExecutable` e `PYTHON (env var)`. `SELF` vem de `relative(...)` com
separadores `\` no Windows; `relativePath(...)` normaliza os caminhos varridos
para `/`. Assim, a comparação `path === SELF` não exclui esse arquivo. O
primeiro teste, que varre `src/`, passou. Logs da base estão em
`F:/lohra-m25-825/logs-node20/baseline.log` e
`F:/lohra-m25-825/logs-node22/baseline.log`.

O teste novo compila (`npm run typecheck` exit 0 nos dois Nodes) e prende a
representação usada em `SELF` contra o literal independente
`tests/sem-python.test.ts`. Antes da correção, a asserção recebeu
`tests\sem-python.test.ts` em vez de `tests/sem-python.test.ts`; focal exit 1,
3 falhas/4 testes em cada ABI. Logs em `F:/lohra-m25-825/logs-node20/red.log`
e `F:/lohra-m25-825/logs-node22/red.log`.

## Correção e controle negativo

`SELF` agora usa `relativePath(...)`, a mesma função usada pelos caminhos
varridos. Os três casos existentes, `listTsFiles("src")`, `listTsFiles("tests")`,
detectores e `ALLOWED_PYTHON3_LITERAL_FILES` ficaram intactos. A asserção
adicional verifica a equivalência de caminhos; o focal passou 4/4 em ambas as
ABIs. Build, typecheck, lint e format:check saíram 0 em cada clone. A prova
`npm run prova -- windows-self-scan-path` retornou, em ambos:

```json
{ "ok": true, "total": 4, "falhas": [] }
```

Para o controle negativo, cada clone criou **somente**
`tests/sem-python-negative-825.ts` com o texto
`export const blockedIdentifier = 'runPythonProcess';`. O comando focal acima
falhou com exit 1 e um único hit
`tests/sem-python-negative-825.ts: runPythonProcess`; os outros três casos
passaram. A fixture própria foi removida por caminho literal em `finally`.
O mesmo comando repetido saiu 0 com 4/4, sem resíduo da fixture. Nenhum
interpretador Python foi invocado. Os logs locais estão em
`F:/lohra-m25-825/logs-node{20,22}/{negative,restored,proof}.log`.

Esta sonda altera arquivos apenas nos clones descartáveis da respectiva ABI;
não há skip, nova entrada na allowlist ou exclusão de outro arquivo no teste
versionado. O controle negativo mecânico do CI pode classificar a PR como
test-only e registrar SKIP; esta injeção externa é o teste de detecção real.
