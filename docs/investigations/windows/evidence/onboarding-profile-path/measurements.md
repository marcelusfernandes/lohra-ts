# #854 — caminho nativo do perfil

Base `039a057e13f66bd62b33953979ca0a5b7a6542ae`, vermelho
`835d84f` e correção `4d1d9d5a55935cc4a783981db3f39fc61c77bdd5`.
Medições em Windows 11 x64, Node 20.20.2 e 22.23.2, com clones e
`node_modules` separados por ABI em `F:/lohra-m25-854/node{20,22}`.
`HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP` e cache,
prefixo e configuração npm apontaram para diretórios próprios de cada clone.
`npm ci --no-audit --no-fund` retornou 0 em ambos. Os arquivos de teste e
prova medidos têm hashes SHA-256 iguais aos do commit `4d1d9d5`; ao final,
os clones foram posicionados nesse próprio SHA e o teste focal voltou a passar.

O focal usa
`node node_modules/vitest/vitest.mjs run tests/onboarding.test.ts -t 'matches list/create outputs and keeps create idempotent'`.
Na base, retornou 1 nas duas ABIs: a saída real terminava em
`\profiles\team_a`, enquanto o esperado terminava em `/profiles/team_a`.
O vermelho acrescentou a comparação exata do envelope `{code, stdout, stderr}`
com `join(base, "profiles", "team_a")`, manteve temporariamente a comparação
antiga e preservou listagem e idempotência. `npm run typecheck` retornou 0
em ambas as ABIs; o focal continuou vermelho somente na comparação antiga.
Os logs estão em `F:/lohra-m25-854/node{20,22}/{baseline-profile,red-profile,red-typecheck}.log`.

No SHA corrigido, o focal retornou 0 em Node 20 e 22. O arquivo completo,
`node node_modules/vitest/vitest.mjs run tests/onboarding.test.ts`, retornou
1 com **8 de 9 testes passando** nas duas ABIs. A única falha é a asserção
inalterada de `.env` em `tests/onboarding.test.ts:51`:
`statSync(path).mode & 0o777` recebeu `438` (`0o666`) e esperava `384`
(`0o600`). Trata-se da lacuna de permissões de #852, sem aceite nesta issue.
O comando `npm run prova -- windows-onboarding-profile-path` também retornou
1 nas duas ABIs, com `{"ok":false,"total":9}` e somente essa falha.
O perfil, sua mensagem completa, `code`, `stderr`, listagem e idempotência
passaram; **não** há prova Windows do arquivo inteiro verde.

| Ambiente             | Build | Typecheck | Lint | Format | Focal perfil |     Arquivo / prova |
| -------------------- | ----: | --------: | ---: | -----: | -----------: | ------------------: |
| Windows Node 20.20.2 |     0 |         0 |    0 |      0 |            0 | 1 / 1 (`.env`, 8/9) |
| Windows Node 22.23.2 |     0 |         0 |    0 |      0 |            0 | 1 / 1 (`.env`, 8/9) |

Logs locais: `F:/lohra-m25-854/node{20,22}/{build,typecheck,lint,format-check,green-profile,green-file,proof}.log`.
Nenhuma asserção de `.env` foi modificada ou omitida. Não há alteração em
`src/`; dogfooding de runtime é N/A para tests/prova/docs.

## Controle Linux no mesmo SHA

No container `lohra-m25-linux-20261009`, clone próprio
`/work/lohra854` do commit `4d1d9d5`, usuário `node` (UID 1000), Node 22 e
`HOME`, `LOHRA_HOME`, `CODEX_HOME`, `TMPDIR` e cache npm isolados em
`/tmp/lohra854`, `npm ci --no-audit --no-fund` retornou 0. `npm run build`,
`npm run typecheck`, `npm run lint` e `npm run format:check` retornaram 0.
`npm test -- --maxWorkers=1` retornou 0: 340 arquivos, 4498 testes passaram e
8 foram pulados pela plataforma (4506 no total). `npm run prova --
windows-onboarding-profile-path` retornou 0 com
`{"ok":true,"total":9,"falhas":[]}`. O controle negativo mecânico com
`--base 039a057e13f66bd62b33953979ca0a5b7a6542ae --head 4d1d9d5a55935cc4a783981db3f39fc61c77bdd5 --slug windows-onboarding-profile-path`
retornou 0, classificado **SKIP test-only**; o vermelho do teste é demonstrado
pelos logs Node 20/22 e pelo commit `test(red):` acima, não por um falso
`assertion-red` mecânico. Logs completos: `F:/lohra-m25-854/linux-evidence/`.
