# #802 — npm portável no controle negativo

Base: `ebeb722f898bdb4cde5b7d7cef66fb40febf5c15`. Commit vermelho:
`bb6d564f88cf9ce91aec4de35d33a345b258e640`. Candidato verde:
`0238308bf399703d8f9a689a7a1ea18140c41767`.

Clones descartáveis e independentes em `F:/lohra-m25-802/node20` e
`F:/lohra-m25-802/node22`, com `npm ci` separado, `HOME`, `USERPROFILE`,
`LOHRA_HOME`, `CODEX_HOME`, cache npm e temporários isolados em F:. As duas
pastas `node_modules` eram diretórios regulares, sem junction, com Vitest
presente após as sondas. Nenhum home ou dependência compartilhada foi usado.

| Ambiente                  | Vermelho (`vitest run tests/ci-controle-negativo-integracao.test.ts -t 'npm CLI'`) | Verde (`npm run prova -- windows-negative-npm`) | `build`, `typecheck`, `lint`, `format:check` |
| ------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Windows x64, Node 20.20.2 | exit 1; 0/1; `spawnSync npm.cmd EINVAL`                                            | exit 0; 122/122                                 | exits 0/0/0/0                                |
| Windows x64, Node 22.23.2 | exit 1; 0/1; `spawnSync npm.cmd EINVAL`                                            | exit 0; 122/122                                 | exits 0/0/0/0                                |

O vermelho invocou o teste comportamental compilável, usando um npm CLI fake
num caminho com espaços. O fake não foi chamado porque o processo recusou
`npm.cmd` antes de executar a prova. O verde registra o fake chamado com
`["run", "-s", "prova", "--", slug]`, `cwd` na base descartável, saída
`assertion-red` e ausência das variáveis `VITEST_FAKE_SENTINEL` e
`LOHRA_PROVA_OUT` no processo da prova. Outro teste força npm CLI inexistente:
exit 1, causa `NPM_CLI_NOT_FOUND` e worktree temporário removido. A prova
também contém os testes preexistentes de aprovação vazia, vermelho estrutural
e cleanup; nenhuma expectativa ou skip foi retirado.

Quando a suíte é lançada por `npm`, ela herda `npm_execpath`. A fixture que
sobrescreve essa variável produzia no Windows duas chaves equivalentes com
caixas diferentes, e `spawnSync` podia selecionar a herdada. O helper de
teste agora remove somente a variante herdada de cada chave explicitamente
sobrescrita pela fixture antes de lançar o filho. O teste de isolamento
temporário também define `TEMP` e `TMP` junto de `TMPDIR`, pois `os.tmpdir()`
em Windows consulta `TEMP`; mantém as verificações de `cwd` dentro do
diretório isolado e ausência de resíduos após cleanup.

Os relatórios brutos ficaram fora do repositório em `F:/lohra-m25-802/`:
`red-focused-node{20,22}.{json,log}`, `green-prova-node{20,22}.log` e
`gate-*-node{20,22}.log`. Não foram copiados porque contêm caminhos locais
extensos de fixtures. Este resumo preserva comandos, versões, exits e
contagens sem dados do perfil do usuário.

No Linux x64, Node 22, o clone próprio `/work/lohra802` no container
`lohra-m25-linux-20261009` foi fixado em
`0238308bf399703d8f9a689a7a1ea18140c41767`, com dependências próprias.
`npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm test -- --maxWorkers=1` e
`npm run prova -- windows-negative-npm` tiveram exit 0. A suíte passou
336 arquivos, 4389 testes e quatro skips preexistentes; a prova passou
122/122. O controle negativo sem `--slug`, com base `ebeb722f` e HEAD
`0238308`, teve exit 0 e classificou `assertion-red`: os dois testes novos
falharam na base, que não chamava o wrapper npm e não preservava causa de
resolução. Resultados brutos em `F:/lohra-m25-802/linux-evidence/` (logs e
`results.tsv`), fora do repositório.

CI e revisão independente: pendentes neste checkpoint.
