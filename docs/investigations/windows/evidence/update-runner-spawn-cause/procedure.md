# Reproduzir #816

Use a base `74e76be9f82de0f9b0f745f0f9898edbbcc179a6` e clones Git
independentes para Node 20 e Node 22, cada um com `npm ci` e diretórios
temporários próprios fora do checkout. Defina `HOME`, `USERPROFILE`,
`LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, `npm_config_cache` e
`npm_config_prefix` antes de executar. Aplique o teste e a declaração de
prova do commit vermelho `a2bd604` sem a mudança de produção.

```text
node node_modules/vitest/vitest.mjs run tests/self-update-runner.test.ts --maxWorkers=1
npm run prova -- update-runner-spawn-cause
```

O primeiro comando deve falhar na asserção do runner real, com TypeError
`Buffer.from(null)` no Windows Node 20 e `Buffer.from(undefined)` no Windows
Node 22/Linux. A prova vermelha Windows Node 22 também inclui a fixture
`echo` pré-existente. Depois aplique o código/testes do commit `9d098f9` e
execute, em cada ABI:

```text
node node_modules/vitest/vitest.mjs run tests/self-update-runner.test.ts tests/self-update.test.ts --maxWorkers=1
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- update-runner-spawn-cause
```

No Linux, execute os cinco gates canônicos na ordem acima (incluindo
`npm test -- --maxWorkers=1` após `format:check`), a prova, o controle negativo
com `--base 74e76be --head <HEAD> --branch fix/816-update-runner-spawn-cause`
e `npm run mutations:self-update`. O controle negativo tem de retornar
**assertion-red**; não aceite sucesso estrutural como prova.

Para dogfooding, compile o worktree candidato e invoque `node dist/cli.js
chat --json --no-input --max-iterations 3 --max-parallel 1 <prompt>` com a
configuração de assinatura já existente fora do repositório. O prompt deve
pedir `read_file` do `src/self-update/repo.ts` do próprio worktree e retornar
um marcador inofensivo. Verifique exit 0, `error:null` e a chamada
`read_file`; não execute o comando `update` como teste.

## Rodada 2 — stderr prévio e limite em bytes

O controle negativo da primeira revisão encontrou outro formato real de
`ENOBUFS`: um filho escreve `PRE` em stderr antes de exceder 1 MiB em stdout.
Na versão `1871ecb`, `defaultCommandRunner` retornava `stderr: "PRE"`, sem
`ENOBUFS` ou `truncated`. Reproduza com a fonte externa preservada em
`F:/lohra-816/review-enobufs.mjs`; o teste versionado
`tests/self-update-runner.test.ts` prende a mesma causa e também o caso de
stderr cheio. O commit `68a33d5` reprova no primeiro caso, `1894750` acrescenta
o segundo vermelho, e `e39c9aa` os satisfaz.

O controle adicional `F:/lohra-816/probe-utf8-bound.mjs` mostrou que
`spawnSync` pode entregar 1.048.579 bytes depois de codificar uma saída com
emoji na fronteira. O teste `c9695b4` reprova com `stdout` de 1.048.578 bytes
no código `e39c9aa`; `e943dac` corta na fronteira UTF-8 e mantém os dois
campos em no máximo 1.048.576 bytes. Execute no candidato final:

```text
node node_modules/vitest/vitest.mjs run tests/self-update-runner.test.ts tests/self-update.test.ts --maxWorkers=1
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- update-runner-spawn-cause
```

No Linux acrescente `npm test -- --maxWorkers=1`, controle negativo com a base
original e `npm run mutations:self-update`. As saídas finais por ABI e SHA ficam
no adendo de [measurement.md](measurement.md); não use os logs da rodada
intermediária `e39c9aa` como gates do candidato final.
