# #829 — home das fixtures duráveis

## Mudança e limite

Quatro chamadas de `runChat`/`runDashboard` agora usam a mesma variável local `home = join(root, ".lohra")` em `options.home` e `options.environment.LOHRA_HOME`. `HOME` continua apontando para `root`. Nenhum estado global, código de produto, leitor de banco, nome de teste, assertion, espera ou timeout foi alterado. A comparação dos nomes `it(...)` antes/depois deu 2/2 idênticos em cada arquivo. O diff de produção é vazio. Dogfood com provider externo: N/A (somente tests/prova/docs).

Base `603c31ec26edfd84fd25a0fdef8d4419a8dd51c7`; vermelho compilável `658d712d3babb268ac00e45b37bdece4c91ddc78`; código verde `9b8b6d34d8614789fc960d094117144096852a50`. Executado em 2026-10-11, Windows nativo x64 e Linux Docker em usuário `node`.

## Vermelho nativo

Clones separados em `F:\lohra-m25-829\node20` e `node22`, cada um com seu `npm ci` (exit 0), home, cache, prefixo e temp próprios fora do clone. `npm test -- --maxWorkers=1 tests/workflow-durable-chat.test.ts tests/workflow-durable-dashboard.test.ts` falhou em **2 arquivos/4 testes em cada ABI**. Primários: os dois cenários chat falharam com `ENOENT` ao ler `root/.lohra`; os dois cenários dashboard falharam em `expect(token).toBeDefined()`. Os logs também registraram `EBUSY` de limpeza de `root/lohra/state.db` como erro secundário e `ENOENT` não tratado de leitura; isso não foi contado como mais testes e não foi apagado da evidência. O estado estava espalhado entre o home do leitor e o default do runtime. Esses erros provam a divergência da fixture, mas não uma falha do mecanismo durável.

| ABI              | Runtime                      | Baseline   | Após ajuste  | Gates nativos                               | Prova       |
| ---------------- | ---------------------------- | ---------- | ------------ | ------------------------------------------- | ----------- |
| Node 20.20.2 x64 | portátil, ABI próprio        | 4 falhas/4 | 4 passaram/4 | build, typecheck, lint, format:check exit 0 | 4/4, exit 0 |
| Node 22.23.3 x64 | instalação host, ABI próprio | 4 falhas/4 | 4 passaram/4 | build, typecheck, lint, format:check exit 0 | 4/4, exit 0 |

As provas estão em `F:\lohra-m25-829\node{20,22}\.prova\windows-durable-fixture-home\resumo.json` (`ok: true`, `total: 4`, `falhas: []`). Os logs brutos permanecem em `F:\lohra-m25-829\<etapa>-<ABI>.log`. SHA-256: `baseline-20.log` `9C23ACB9328D7A50A09B93CD7D1C72B6BBFD60079E9C98D6B800FE6B1CD2E910`; `baseline-22.log` `93DD2F8E61FD8EE8599616918957D5CC4EB5CABD23DD71561AEA2322BE150076`.

## Controle Linux

O clone independente `/work/lohra829` no container `lohra-m25-linux-20261009` foi pinado em `9b8b6d34d8614789fc960d094117144096852a50`, com `npm ci` próprio, usuário `node`, HOME/LOHRA_HOME/CODEX_HOME/TMP separados sob `/tmp/lohra829-isolation`. `npm ci`, build, typecheck, lint, format:check, suíte completa `--maxWorkers=1` e prova passaram (todos exit 0). Suíte: **339 arquivos, 4437 testes passaram, 4 skips existentes**. Prova: **4/4**. O controle negativo test-only retornou exit 0 e `SKIP`: diff exclusivamente tests/prova, base+overlay equivalente ao head; o vermelho é o commit e os logs nativos acima. Logs em `F:\lohra-m25-829\linux-evidence-final\`; SHA-256 do `test.log`: `B188AAC6FAE7D99FE92052BA69B811C71A2AAFC25FD879EE4699CD48732B145C`.

O primeiro comando local de controle negativo usou por engano `--branch test/835-windows-durable-fixture-home`. Sua saída `negative-wrong-branch.log` foi preservada mas **não é evidência válida** para #829. Somente esse comando foi repetido, com `--branch test/829-windows-durable-fixture-home`, exit 0 e `SKIP` esperado; o comando exato e resultado constam em `negative.log`. Não houve repetição da suíte nem dos gates por isso.

## Repetição

Os comandos e as duas fontes de execução isolada estão em [replay.md](replay.md). Os logs são locais e não foram adicionados ao Git; o resumo acima inclui contagens, causas primárias e secundárias, hashes e os SHAs executados. Os quatro cenários continuam testando persistência, auditoria, liberação de lease e conclusão do shutdown; não há teste específico de alteração de política de abort nesta issue.
