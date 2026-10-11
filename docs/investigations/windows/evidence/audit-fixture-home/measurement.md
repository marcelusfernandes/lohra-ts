# #839 — home das fixtures de auditoria

Código medido: base `96756a53e03a87ddb3edfa2a419f756c493a1f3f`, vermelho compilável `7bf6809`, correção `68dd1cd2bdcfac890fb2d22b41c4257adce3c3e1`.

## Reprodução nativa

Dois clones Git descartáveis e independentes em `F:`, cada um com `npm ci` próprio (exit 0), foram executados com Node 20.20.2 e 22.23.2. `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, cache/prefixo npm e `TEMP`/`TMP`/`TMPDIR` apontaram para diretórios próprios em `F:`. Nenhum banco ou credencial do usuário foi consultado.

Comando focal: `npm test -- --maxWorkers=1 tests/workflow-audit-live.test.ts`.

| Versão       | Base                              | Correção      | Prova (`npm run prova -- windows-audit-fixture-home`) |
| ------------ | --------------------------------- | ------------- | ----------------------------------------------------- |
| Node 20.20.2 | 37 passam, 2 falham de 39; exit 1 | 39/39; exit 0 | 39/39; exit 0                                         |
| Node 22.23.2 | 37 passam, 2 falham de 39; exit 1 | 39/39; exit 0 | 39/39; exit 0                                         |

As falhas originais, idênticas nas duas versões, foram:

1. `routes workflow_audit through the actual runChat composition root`: eventos observados `[]`, esperados `["leaf.started"]` (`AssertionError`, linha 159).
2. `lists an empty durable home and audits an unknown run without provider`: `ENOENT` ao ler `<TEMP>/lohra-t17-cli-*/.lohra/state.db` (linha 1200).

Sonda executada em Node 22 com o `environment` original `{ HOME: root, PATH: "x" }` chamou `resolvePaths`: seed `F:\\isolated-probe-839\\.lohra\\state.db`, leitor `F:\\isolated-probe-839\\lohra\\state.db`, `same:false`. O código em `src/config/paths.ts` escolhe `LOCALAPPDATA || HOME` seguido de `lohra` no Windows quando `LOHRA_HOME` está ausente. A correção define `LOHRA_HOME: join(root, ".lohra")` apenas nos dois environments da fixture; o seed, leitores, nomes, assertions e marcadores permanecem iguais. O arquivo tinha e continua com 1.211 linhas. Não houve alteração de `process.env` global.

Quatro gates nativos (`build`, `typecheck`, `lint`, `format:check`) passaram em ambas as versões. A prova passou em ambas, sem skips novos. Dogfood de provider: N/A, pois o diff toca somente teste, declaração de prova e esta evidência.

## Reprodução

Partindo dos SHAs acima em clones limpos com instalações npm próprias e ambiente isolado:

```text
npm ci
npm test -- --maxWorkers=1 tests/workflow-audit-live.test.ts
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- windows-audit-fixture-home
```

Para o vermelho, use a base. Para o verde, use `68dd1cd`. O clone Linux usa Node 22 como usuário não privilegiado e o mesmo commit de código.

## Linux e gates de PR

Clone Linux próprio `/work/lohra839`, usuário `node`, HEAD `68dd1cd2bdcfac890fb2d22b41c4257adce3c3e1`, com `HOME`/`LOHRA_HOME`/`CODEX_HOME`/cache/TEMP próprios sob `/tmp/lohra839-isolation`. `npm ci` e os cinco gates canônicos saíram com código 0. A suíte completa terminou com **340 arquivos, 4.455 testes aprovados e 8 skips preexistentes** em 282,52 s. A prova retornou `{"ok":true,"total":39,"falhas":[]}`. Os skips não foram introduzidos pelo diff de duas linhas e declaração de prova.

`npm run ci:contratos` com evento `pull_request` contendo base `96756a5` e head `68dd1cd` reais retornou `contratos: 2 arquivo(s), nenhuma violação`, exit 0. A base tem 1.211 linhas e o candidato tem 1.211; nenhum caso, nome, assertion ou marcador foi movido, como mostra o diff de apenas dois environments. O gate usa o blob da base, não uma base fictícia.

`npm run ci:controle-negativo -- --base 96756a5... --head 68dd1cd... --branch test/839-windows-audit-fixture-home` saiu 0 com **SKIP test-only**: o overlay de `tests/**` e `prova/**` na base é equivalente ao head e não discrimina a correção. O vermelho próprio nas duas ABIs acima é a evidência discriminante. A primeira chamada do script Linux usou por erro `--branch test/836-windows-audit-fixture-home`; seu log foi preservado como `negative-wrong-branch.log` e não é contabilizado como gate da issue. Só a repetição com branch exata é válida. Não se repetiu a suíte completa, que independe do argumento da etapa posterior.

Logs integrais isolados (não versionados) estão em `F:/lohra-m25-839/`, inclusive `linux-evidence/`, com resultados por etapa em `linux-evidence/results.tsv`. SHA-256 dos logs vermelhos Node20/22: `ECD9D7EB30D49482B0C511A6F16441810979786B6E269017208FBAAB4F055D94` / `EBD80AA45DF9AD54C91BAFAD8FC1239BD317228FE3731AE20B3FD49573ABD3E1`; logs focais verdes: `F8B9DC8B0E9D60E1309B612B39A0F2CA1A34426852C25401C991FB0CB9D9555A` / `E9FD726F200F7C113B65117F758EA2A90146E990B912A65D42BAC3C1219D562E`.
