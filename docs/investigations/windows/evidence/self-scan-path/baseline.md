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
representação usada em `SELF`. Antes da correção, a asserção recebeu
`tests\sem-python.test.ts` em vez de `tests/sem-python.test.ts`; focal exit 1,
3 falhas/4 testes em cada ABI. Logs em `F:/lohra-m25-825/logs-node20/red.log`
e `F:/lohra-m25-825/logs-node22/red.log`.
