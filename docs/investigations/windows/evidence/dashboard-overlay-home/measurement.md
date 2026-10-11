# #828 — home da fixture de overlay WS

Base `dce780c1d1c96ddc9ec6c91e47922e3b6eeb5b06`, vermelho compilável `43368fc7ea828cf151c0eebc2e5370a191164bec`, código verde `e39845f2ad051359128fc7ef9e1e32d3d4280d56`. Medido em 2026-10-11 com clones e dependências próprios por ABI, homes e temps isolados em `F:\lohra-m25-828`.

## Causa e alteração

Antes, o helper `bootDashboard` passava `environment: {HOME: root, PATH: ...}` e `home = root/.lohra`. Seed e leitura posterior usam `home/state.db`, mas `runDashboard` abre `openStateForEnvironment(options.environment)`. `resolvePaths` em Windows sem `LOHRA_HOME` seleciona `HOME/lohra`; em POSIX seleciona `HOME/.lohra`. Uma sonda executável com `resolvePaths` real e o environment exato do helper, em Node 20 e 22, produziu `{seed:".lohra", runtime:"lohra", same:false}` (caminhos relativos a um root sintético). Com `LOHRA_HOME: home`, a mesma sonda produziu `{seed:".lohra", runtime:".lohra", same:true}` em ambas. JSONs em `F:\lohra-m25-828\cause{,-green}-node{20,22}.json`. O root sintético evita expor caminhos pessoais.

Somente a propriedade `LOHRA_HOME: home` do environment local e o comentário que pressupunha o default POSIX foram alterados. `HOME`, seeds, leitores, requests/frames, prompt, histórico, ack, âncora positiva do input cru, quatro nomes `it(...)`, assertions, marcadores e timeouts permanecem. Os quatro nomes foram comparados com a base e são idênticos. Não há mudança de produto ou ambiente global. Dogfood externo: N/A (tests/prova/docs).

## Vermelho e verde nativos

`npm test -- --maxWorkers=1 tests/gateway/dashboard-ws-overlay.test.ts` na base: **1 arquivo, 4/4 testes falhos em cada ABI**. Mesmo perfil em Node 20 e 22: notice ausente (`'hi'` sem bloco), nenhuma chamada ao aux, só uma chamada no caso sem aux e frame de fallback ausente. Após ajuste: **4/4 passaram** em ambas. Nenhuma assertion foi relaxada para converter o resultado.

| ABI                       | `npm ci` | build | typecheck | lint | format:check | prova       |
| ------------------------- | -------- | ----- | --------- | ---- | ------------ | ----------- |
| Node 20.20.2 x64 portátil | 0        | 0     | 0         | 0    | 0            | 4/4, exit 0 |
| Node 22.23.3 x64 host     | 0        | 0     | 0         | 0    | 0            | 4/4, exit 0 |

Os clones `node20`/`node22` têm dependências próprias, sem junction. Provas em `F:\lohra-m25-828\node{20,22}\.prova\windows-dashboard-overlay-home\resumo.json` (`ok:true,total:4,falhas:[]`). Logs brutos em `F:\lohra-m25-828\<etapa>-<ABI>.log`; o guia [replay.md](replay.md) contém comandos e fontes do harness. Nenhum dado de provider externo foi usado.

SHA-256 dos logs do vermelho: Node20 `54E07B8F569A1E6DF3ACFF39400A1B9E2956FBC43ABC563A4AC2035AE4921D4A`; Node22 `AA5FC2ED625EA34039186CF091E22FBD846FAA422DFAE600C07BBE4781D0BBB4`.

## Linux e controle negativo

Clone independente `/work/lohra828` no container `lohra-m25-linux-20261009`, usuário `node`, pinado em `e39845f2ad051359128fc7ef9e1e32d3d4280d56`, com dependências e HOME/LOHRA_HOME/CODEX_HOME/TMP próprios. `npm ci`, build, typecheck, lint, format:check, suíte completa `--maxWorkers=1`, prova e controle negativo saíram **0**. A suíte teve **339 arquivos, 4439 testes aprovados e 4 skips existentes**; prova **4/4**. O controle negativo retornou `SKIP` esperado porque o diff é exclusivamente tests/prova, base+overlay equivalente ao head; o vermelho compilável e a reprodução nativa acima discriminam a mudança. Logs em `F:\lohra-m25-828\linux-evidence\`, incluindo `results.tsv`, `head.txt` e `negative.log`; SHA-256 `test.log` `E22FE27FB097958DDEF994C4AC97EB59CFBCD899508C65E5F70F42B422D2CCC1`. O checkout Linux não tinha alterações rastreadas após a medição.
