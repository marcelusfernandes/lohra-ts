# Regressão do fixture `serve` (#804)

O alvo é `tests/cli-serve-process.test.ts`, que verifica o parser real com as formas exact/inline/abbreviated. O teste faz apenas `GET /v1/models` em loopback e passa uma chave **literal fictícia**; nenhuma chamada de completion ou provider live foi feita. Em Windows, `child.kill('SIGINT')` é terminação usada na limpeza, não Ctrl-C de console nem prova do handler gracioso. A medição de Ctrl-C real está em [#730](../../shutdown-validation.md).

## SHAs, ambiente e comandos

- Base antes da mudança: `ee6db18070b13a8c973edee622d07cccaed88ea8`.
- Checkpoint TDD vermelho compilável: `90b5c023265d940ced7701e830f1902ebfdd9045` (novo `signal`/`portAvailable` ainda provisórios).
- Implementação medida: `7aa3b8e2cbcbe5714999ebb2b60b1e3858805df1`; o commit documental posterior não altera o teste.
- Windows 11 x64; Node 20.20.2/npm 10.8.2 e Node 22.23.2/npm 10.9.8. Dois clones Git independentes em F:, checkout detached na base, `npm ci` separado por ABI, exit 0. `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, cache e prefixo npm foram exclusivos por clone.

Antes da mudança, em cada clone:

```text
<NODE.EXE> node_modules/vitest/vitest.mjs run tests/cli-serve-process.test.ts --maxWorkers=1 --reporter=json --outputFile=F:/lohra-804/logs/base-<NODE>.json
```

Depois, com os dois arquivos permitidos da implementação copiados para o clone da mesma ABI:

```text
<NODE.EXE> <NPM-CLI.JS> run prova -- windows-serve-process-signal
```

O runner da prova invoca `tests/cli-serve-process.test.ts` e grava `vitest.json`/`resumo.json`. Os [resultados Node 20](before-after-node20.json) e [22](before-after-node22.json) projetam cada asserção com hashes SHA-256 dos JSONs/logs brutos preservados somente em `F:/lohra-804/logs` e nos `.prova` dos clones. Os contadores foram reconciliados ao reporter: base exit 1, 3/3 FAIL; candidato prova exit 0, 3/3 PASS. O [checkpoint vermelho](red-checkpoint.json) compilou (`tsc --noEmit` exit 0) e falhou 3/3 em Node 22 por expectativa nova de `signal:'SIGINT'`, distinta do vermelho original por `exitCode===0`.

## Contrato e limite

As asserções existentes de HTTP 200, JSON de lista, avisos de ferramentas/`--insecure` e ausência de impressão da chave permanecem antes das asserções de saída. Agora o fixture guarda `exitCode` **e** `signal`; no Windows exige `null`/`SIGINT`, em POSIX exige `0`/`null`. Após o evento `close`, tenta vincular a mesma porta e exige que esteja livre. Se a observação falhar, o cleanup pede `SIGKILL` somente ao filho próprio e espera seu `close` por até 2 s **antes** de remover o diretório. Falha de cleanup juntamente com falha primária forma `AggregateError`, com a primária em `errors[0]` e erro de cleanup em `cause`, conforme a regra `preserve-caught-error` do repositório. `allocatePort` precede a criação do temporário, evitando vazamento se essa etapa falhar.

O teste continua sendo de parser/resposta; saída 0 nativa após Ctrl-C real permanece contrato separado de #730/#757. Nenhum teste foi pulado, nenhuma asserção de HTTP/aviso removida, nenhuma mudança em produto, IPC ou ConPTY foi introduzida. Os gates nativos e Linux, prova e controle negativo são registrados na PR. A [fonte do projetor](source.md) e os arquivos de evidência não contêm segredos ou caminhos pessoais.
