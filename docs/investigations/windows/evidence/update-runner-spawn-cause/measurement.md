# #816 — causa de falha ao iniciar comando do updater

As medições até a tabela de hashes abaixo documentam a **rodada 1** da PR
#837. A revisão encontrou uma falha adicional de `ENOBUFS` com stderr prévio;
o candidato final e seus gates estão separados no adendo da rodada 2 ao fim
deste arquivo. Não atribuir os resultados anteriores ao novo SHA.

Base `74e76be9f82de0f9b0f745f0f9898edbbcc179a6`; vermelho compilável
`a2bd604ded2fdcb54feab5c2066d0ed2e468e1b0`; código candidato
`9d098f9950b878cced37a9cf863c929bb270d38f`. As medições nativas usaram
dois clones Git independentes com `npm ci` por ABI e `HOME`, `USERPROFILE`,
`LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, cache e prefixo npm externos e separados.
Node 20.20.2/npm 10.8.2 e Node 22.23.2/npm 10.9.8 em Windows 11 x64.
Os quatro arquivos de código/prova aplicados nos clones tinham SHA-256 idêntico
ao worktree candidato; os HEAD dos clones continuaram na base, portanto não se
alega checkout limpo no SHA candidato.

| Etapa                                                                           | Node 20                     | Node 22                                   |
| ------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------- |
| `npm ci`                                                                        | exit 0                      | exit 0                                    |
| Vermelho focal `tests/self-update-runner.test.ts`                               | 1 FAIL: `Buffer.from(null)` | 1 FAIL: `Buffer.from(undefined)`          |
| Prova vermelha                                                                  | não medida                  | exit 1: falha nova e fixture `echo` POSIX |
| Foco candidato `tests/self-update-runner.test.ts` + `tests/self-update.test.ts` | 12/12 PASS                  | 12/12 PASS                                |
| Build → typecheck → lint → format:check                                         | quatro exit 0               | quatro exit 0                             |
| `npm run prova -- update-runner-spawn-cause`                                    | 12/12 PASS, exit 0          | 12/12 PASS, exit 0                        |

O teste vermelho chama o **runner real** com executável inexistente e exige
`code` não zero, `stdout` vazio e `stderr` com `ENOENT` e o nome do executável.
Antes da correção, `spawnSync` devolveu `status=null`, `error.code=ENOENT` e
streams `null` no Node 20 ou `undefined` no Node 22; `bounded` lançou TypeError
antes de examinar `result.error`. A correção converte somente saídas ausentes
em string vazia e usa `result.error.message` quando `stderr` falta. Preserva
`shell:false`, timeout de 30 segundos, limite de saída de 1 MiB, argv e o
formato de `CommandResult`. O teste de saída grande confirma `truncated:true`,
saída de no máximo 1 MiB e causa `ENOBUFS`; o teste positivo confirma
`stdout=OUT`, `stderr=ERR`, `code=0`. A fixture de literalidade agora usa o
Node já instalado e compara o vetor JSON de argumentos com `&&` literal.

Em Linux, o vermelho focal no mesmo commit `a2bd604` também falhou com
`Buffer.from(undefined)`. O controle negativo na base, aplicado ao candidato
`9d098f9`, retornou exit 0 com classificação **assertion-red**: os testes de
`ENOENT` e `ENOBUFS` falharam na base. Não houve autoatualização, fetch, pull
ou instalação disparados pelas fixtures; os subprocessos foram Node próprio e
um executável inexistente. Logs brutos, inclusive saídas de gates, ficam em
`F:/lohra-816/`; comandos são descritos em [procedure.md](procedure.md).

No clone Linux Node 22 do código `9d098f9`, `npm ci`, build, typecheck, lint,
format:check, `npm test -- --maxWorkers=1`, prova e controle negativo tiveram
exit 0. A suíte passou **337 arquivos, 4406 testes**, com quatro skips
preexistentes, em 188,23 segundos; a prova passou 12/12. O código de produção
medido é idêntico ao candidato da PR; a nota documental foi acrescentada depois.

Dogfooding real no `dist/cli.js` compilado do commit `9d098f9`, com provider de
assinatura configurado fora do repositório: exit 0, JSON válido, `error:null`,
uma chamada `read_file` para o arquivo alterado e marcador esperado na
resposta. Só esses campos sanitizados foram gravados em
`F:/lohra-816/dogfood-result.json`; não há credenciais nesta evidência.

`npm run mutations:self-update` no mesmo clone Linux retornou exit 0,
**12/12 mutantes mortos**, nenhum sobrevivente e `restoreGreen:true`. O mutante
`T22-updater-shell`, em `src/self-update/repo.ts`, foi morto pelo teste portátil
de argv literal; após a fatia, `git status --short` no clone continuou vazio.

Hashes SHA-256 dos logs brutos preservados em `F:/lohra-816/`:

| Log                                     | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `red20.log`                             | `25D5E87154B49E50B9EEB6CF0B20D8008FC71674FE229ED9A75D4CA44713157C` |
| `red22.log`                             | `9C4E810A3E82BAF9042199A576D58E526CF7FFDAAF418FED4A43CEAC84BE88AC` |
| `linux-gates/test.log`                  | `8BE841FDFBCEA9EDB2DC38EBB6AC0C051BCA47E13BB9E5351BF635C2CA3D4A6F` |
| `linux-gates/mutations-self-update.log` | `65AF6A77CB54F772F75C45877B80CC69093B0F73AB0C33999BEC7FF2FEE06BDE` |
| `dogfood-result.json`                   | `286F82F0A6AB5434BF60CDE1D8C1FEA767A514F87CCFB91A8022CB7515899B90` |

## Rodada 2 — causa observável e limite de saída

A revisão independente reprovou o SHA `1871ecb` com uma sonda real:
`stderr=PRE`, `error.code=ENOBUFS`, `stdout` entregue pelo spawn com exatamente
1.048.576 bytes. O runner devolvia só `PRE` e não marcava `truncated`. A fonte
externa completa está em `F:/lohra-816/review-enobufs.mjs`; o JSON do
veredito e da refutação está em `F:/lohra-816/review-round1-final.json`.

Os commits vermelhos `68a33d5` e `1894750` prendem respectivamente stderr
prévio e stderr cheio, exigindo tanto `PRE` como `ENOBUFS` com saída limitada.
O código `e39c9aa` põe o diagnóstico de `spawnSync` antes do stderr capturado
e marca `truncated` no erro `ENOBUFS`, mesmo quando a stream recebida tem
exatamente 1 MiB. Nenhum campo novo foi acrescentado a `CommandResult`;
`shell:false`, timeout de 30 segundos e argv permanecem.

Uma sonda adicional da fronteira UTF-8 (`F:/lohra-816/probe-utf8-bound.mjs`)
observou até 1.048.579 bytes entregues por `spawnSync` com emoji no fim. No
código intermediário, o teste vermelho `c9695b4` recebeu 1.048.578 bytes no
`CommandResult.stdout`: cortar os bytes no meio do emoji inseria o caractere
de substituição UTF-8. O código final `e943dac` recua o corte até a fronteira
do caractere, mantendo stdout e stderr em no máximo 1.048.576 bytes.

As duas novas famílias de teste reprovaram antes das respectivas correções;
os logs da versão intermediária não servem como gates do código final. A
execução real da CLI compilada de `e943dac` retornou exit 0, `error:null`,
uma chamada `read_file` ao arquivo alterado e o marcador solicitado; o JSON
sanitizado está em `F:/lohra-816/dogfood-round2-result.json`. Não houve
comando `update` ou acesso a segredos pelo relatório.

Matriz do código final `e943dac0e05d8bcf98d9d2031c6703e3ca5ba8a5`:

| Validação                                    | Windows Node 20.20.2                   | Windows Node 22.23.2                   | Linux Node 22                                               |
| -------------------------------------------- | -------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Foco `self-update-runner` + `self-update`    | 15/15 PASS, exit 0                     | 15/15 PASS, exit 0                     | incluído na suíte                                           |
| Build, typecheck, lint, format:check         | quatro exit 0                          | quatro exit 0                          | quatro exit 0                                               |
| `npm run prova -- update-runner-spawn-cause` | 15/15 PASS, exit 0                     | 15/15 PASS, exit 0                     | 15/15 PASS, exit 0                                          |
| `npm test -- --maxWorkers=1`                 | não repetido; baseline Windows externo | não repetido; baseline Windows externo | 337 arquivos, 4409 PASS + 4 skips, exit 0                   |
| Controle negativo                            | não aplicável local                    | não aplicável local                    | assertion-red, exit 0                                       |
| `npm run mutations:self-update`              | não aplicado                           | não aplicado                           | 12/12 mortos, zero sobreviventes, restoreGreen true, exit 0 |

Nos clones Windows os quatro arquivos de src/teste/prova copiados tiveram
SHA-256 idêntico ao worktree `e943dac`; cada clone conserva o HEAD da base,
portanto a tabela qualifica **código copiado por hash**, não checkout no SHA.
Dependências ABI e ambientes temporários ficaram separados em `F:`. Os logs
finais estão em `F:/lohra-816/round2-final-logs/node20/` e `node22/`; o
arquivo `results.txt` registra exit 0 em cada comando. O dogfooding real foi
executado no worktree compilado do SHA final, com resultado sanitizado citado
acima.

A primeira suíte Linux desse SHA foi invocada como `uid=0` e teve quatro
falhas em três arquivos que simulam acesso negado por permissão:
`auth-core.test.ts` (duas), `cron-store.test.ts` e `tools-local.test.ts`.
O log `F:/lohra-816/round2-linux-logs/test.log` preserva os **4405 PASS,
4 FAIL, 4 skips** desse ensaio inválido para tais assertions. O clone próprio
foi transferido a `uid=1000` e a mesma suíte foi repetida com `HOME` e
`TMPDIR` próprios; passou 4409/4409 assertions executadas. Uma tentativa
anterior de gravar o log não iniciou a suíte por permissão do diretório de
logs e foi corrigida antes da repetição. Não se alterou código nem fixture
para tornar os testes verdes. Build, typecheck, lint e format:check do mesmo
SHA tinham passado antes da repetição, e prova, controle negativo e mutação
passaram depois como `uid=1000`; `git status --porcelain` do clone ficou
vazio após a mutação.

Hashes SHA-256 da evidência externa da rodada 2:

| Arquivo                                       | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `round2-linux-logs/test-nonroot.log`          | `ADD1AA5FFBA095448AD63DDA2071154F3326A330D5A99AE2DC5A774D2918F880` |
| `round2-linux-logs/negative.log`              | `C64AED1198D225F296D564446D62618EA077435211F0B0072DEB49412990B50C` |
| `round2-linux-logs/mutations-self-update.log` | `EC56E867909E74FC3DD2BC4AB55591691F4E0273EDFFF75F1FAAAE87412238BF` |
| `dogfood-round2-result.json`                  | `5D4E64084E653A6A7F0ADD7DAC9C1DEA53E8C8D9230791B24330FB13D47E4FC6` |
