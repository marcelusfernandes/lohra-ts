# #816 — causa de falha ao iniciar comando do updater

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
