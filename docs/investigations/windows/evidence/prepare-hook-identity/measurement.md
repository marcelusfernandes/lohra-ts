# #863 — identidade do hook compartilhado

Base `318dfb4d97118fe4704a41ed6d8c82abb59368d9`; vermelho compilável `89167bc8316e4dfa26c591d8056c4037dc7cbe83`; correção `d4b4f0b1b3e9628e597f7f91f2054c5a12826124`.

## Falha observada no runner e limite local

No log histórico do job Windows Node 22 `114436782313` (run `38128169582`, PR #861), o teste original de worktree ligado falhou em `tests/prepare.test.ts:152` comparando duas strings. Esperava `C:\Users\RUNNER~1\…\.git\hooks\pre-push`, recebeu `C:\Users\runneradmin\…\.git\hooks\pre-push`; `runPrepare` havia retornado exit 0. O log bruto está fora do repositório em `F:/lohra-m25-validation-20261010/ci-861-windows22.log`. Essa diferença de grafia, por si só, **não prova** que era o mesmo arquivo. A nova comparação canônica e o CI desta PR devem verificar a identidade no runner.

No host local, a base passou 6/6 em Node 20.20.2 e Node 22.23.2: o alias 8.3 do runner não foi reproduzido. A consulta `fsutil 8dot3name query F:` retornou acesso negado; a disponibilidade de 8.3 em `F:` fica **NOT_MEASURED**, sem alterar política do volume. Para obter um vermelho causal, uma sonda criou uma junction **dentro de TEMP descartável** para o mesmo arquivo `pre-push`. Em ambas as ABIs, `resolve` retornou nomes diferentes, enquanto `realpathSync.native` retornou o mesmo caminho, e `stat` encontrou `dev` e `ino` iguais. Uma segunda sonda usa arquivos distintos com bytes idênticos; a propriedade de identidade rejeita esse par.

Com o helper textual no commit vermelho, o foco passou 7/8 e falhou apenas `recognizes two paths to the same hook file through a controlled alias` (`AssertionError: expected false to be true`) em cada ABI. `typecheck` do vermelho passou. Após usar `realpathSync.native` **sobre arquivos existentes**, o foco passou 8/8 em Node 20/22; os seis casos originais preservaram instalação, idempotência, espaços/metacaractere e causas de erro. O controle negativo de bytes iguais permaneceu verde: conteúdo não substitui identidade. `realpathSync.native` falha explicitamente quando o destino não existe, em vez de aceitar um caminho não resolvido.

Clones nativos independentes `F:/lohra-m25-863/node20` e `node22`, com `npm ci` próprio; homes, cache npm e TEMP isolados em `F:`. Nenhuma configuração Git/volume global foi alterada e nenhuma dependência foi adicionada. Dogfood de provider N/A: o diff toca somente teste, prova e evidência.

## Replay da sonda local

[Fonte integral da sonda](probe-source.md). Para o foco, executar `npm run test -- --maxWorkers=1 tests/prepare.test.ts` no commit base, no vermelho e no verde, com instalações e TEMP separados por ABI. A declaração `prova/windows-prepare-hook-identity.ts` usa o mesmo arquivo. Logs brutos e JSON da sonda estão em `F:/lohra-m25-863/`, fora da branch.

## Gates finais

Em clones nativos independentes Node 20/22: `npm ci`, build, typecheck, lint, format:check e `npm run prova -- windows-prepare-hook-identity` retornaram 0; prova `{"ok":true,"total":8,"falhas":[]}` em ambas. O clone Linux próprio `/work/lohra863`, usuário `node`, HEAD `d4b4f0b1b3e9628e597f7f91f2054c5a12826124`, usou homes/cache/TEMP próprios. `npm ci` e os cinco gates saíram 0: **340 arquivos, 4.464 testes aprovados e 8 skips preexistentes** em 218,65 s; prova 8/8. O diff não introduziu skips.

`npm run ci:contratos` com evento de PR contendo base real `318dfb4` e head `d4b4f0b` retornou `contratos: 2 arquivo(s), nenhuma violação`, exit 0. Controle negativo com `--branch test/863-windows-prepare-hook-identity` exata saiu 0 como **SKIP test-only**: overlay da classe de testes/prova na base não discrimina. O vermelho nativo 7/8 fornece a evidência causal separada. Logs integrais Linux em `F:/lohra-m25-863/linux-evidence/`, incluindo `results.tsv`; clone permaneceu limpo.

SHA-256 de logs nativos, na ordem Node20/Node22: baseline `DB2B632D4311F19E47B3A972D4379E01BCFC24CB6C8931AE48C23A3C696A3017` / `C7836A8A7AD7289D1F48E6FD498174619BD5F8D2C6B37B66FCCB98462B56899F`; vermelho `BA5CF49638000646721FDAF417FAAF8CB55BC078228076CD4559C912D0F27010` / `7BD717E08001780926EF8275AF3EBF2BD2842A3B2CD4EC598A63B577507442B7`; verde `75A01ECA91B95747DA986AEC16B90736487DD699F1087F68C116950A621EE854` / `4359AF2E25C3863E8918F573B9646AB8D2A898CFAD55E2131D7F265B74DC1C19`.
