# Release

Como cortar uma versão publicável de `lohra-ts` (issue #531, D2 do épico
#529 — "Distribuição pública"). `scripts/release.ts` (`npm run release --
<patch|minor|major|x.y.z>`) faz o bump e o commit; a tag e a publicação são
passos separados, feitos por outra pessoa/processo.

## O que o script faz

O script roda em duas fases. A fase **COMPUTE** só lê e valida — nada em
disco nem no git muda ainda, e qualquer recusa aqui é limpa (nenhum arquivo
tocado, nenhum commit criado):

1. Valida a árvore de trabalho limpa (`git status --porcelain` vazio) —
   recusa com `RELEASE_TREE_DIRTY` senão.
2. Valida o argumento: `patch`, `minor`, `major` ou um `x.y.z` explícito —
   qualquer outra coisa recusa com `RELEASE_INVALID_VERSION`.
3. Lê `version` de `package.json`, computa a versão-alvo (bump ou o
   `x.y.z` explícito), e confirma que ela é estritamente maior que a atual
   — senão `RELEASE_VERSION_NOT_GREATER` (só se aplica ao `x.y.z`
   explícito; um bump sempre soma 1 em algum componente).
4. Valida a branch atual: precisa ser exatamente `release/<versão-alvo>`.
   `main` recusa com a causa própria `RELEASE_BRANCH_MAIN`; qualquer outra
   branch (inclusive `release/<versão errada>`) recusa com
   `RELEASE_BRANCH_MISMATCH`.
5. Lê o `CHANGELOG.md` existente (se houver) e monta o conteúdo novo —
   sem gravar nada ainda. Se o arquivo existe e não começa EXATAMENTE por
   `# Changelog\n`, recusa com `RELEASE_CHANGELOG_HEADER_UNEXPECTED` em vez
   de descartar o que já está lá (ver "O que o script recusa" abaixo).

Só depois da fase COMPUTE inteira ter sucesso é que a fase **WRITE** roda:

6. Bump em `package.json` (`version`) e, se `package-lock.json` existir,
   nas duas ocorrências do pacote raiz do lockfile (`version` de topo e
   `packages[""].version`) — nunca nas `version` das dependências
   (`node_modules/**` dentro de `packages`), que ficam intactas.
7. Grava a seção nova do `CHANGELOG.md` (gerada a partir dos merges de PR
   — `git log --first-parent --merges`, ver abaixo) no topo do arquivo,
   acima do que já existia.
8. `git add package.json CHANGELOG.md [package-lock.json]` +
   `git commit -m "chore(release): v<versão>"`.

**Nunca cria tag.** Isso é do owner (ou de um workflow futuro de D7), sobre
o merge commit da PR de release em `main` — nunca sobre o commit da branch
`release/<versão>` isolada, que não está em `main` até o merge.

## Sem rede

O script nunca chama `gh`/`gh api` nem qualquer outro serviço de rede. O
histórico de PRs vem inteiramente de `git log --first-parent --merges`
deste repositório: `--first-parent` restringe aos merge commits que
compõem a cadeia principal da branch (exatamente os merges de PR em `main`
— nunca os merges de `origin/main` DENTRO de uma feature branch, que o
passo 10c do fluxo de git produz para resolver conflito, e que não fazem
parte da cadeia principal de `main`). O título de cada entrada é a primeira
linha não-vazia do corpo do merge commit (o corpo que o GitHub grava como
o título da PR ao mergear) — ignorando linhas que começam com `#` (o bloco
`# Conflicts: ...` que o próprio `git merge` anexa quando o merge teve
conflito resolvido manualmente nunca é o título de verdade); sem corpo
utilizável, cai para o assunto do commit. O número da PR vem de `#<n>` no
assunto ou no corpo.

## Agrupamento do CHANGELOG

Sem `gh api`, não há como agrupar por milestone sem rede — o agrupamento é
pelo tipo do conventional commit no título (`feat` → Added, `fix` → Fixed,
`perf`/`refactor` → Changed, `docs` → Docs, `test` → Tests, `chore` →
Chore, `ci` → CI; qualquer outro prefixo, ou nenhum, cai em Other). Nada é
inventado: cada linha é o título real de um merge, com o número da PR entre
parênteses quando encontrado.

## Fluxo completo

A PR de release **não é especial** — segue o mesmo fluxo issue-first de
qualquer outra mudança (`.claude/rules/git-workflow.md`), com uma issue de
tracking, revisor e merge pelo orquestrador:

```
owner:        cria a issue "chore(release): v0.0.12" (skill issue)
owner/agente: gh issue develop <N> --base main --name release/0.0.12
              (o push da ref nova é o lock da issue, como qualquer branch)
agente:       npm run release -- patch          # ou minor/major/x.y.z
agente:       git push -u origin release/0.0.12
agente:       abre PR (Closes #N, AC copiados) — skill pr, state:in-review
CI:           checks + provenance + escopo + contratos + controle-negativo
              (o diff é só package.json/package-lock.json/CHANGELOG.md —
              contratos/controle-negativo não têm o que reprovar)
revisor:      avalia como qualquer PR — AC, escopo, invariantes
orquestrador: merge commit só com checks verdes + review:approved
              (gh pr merge --merge; Closes #N fecha a issue de tracking)
owner:        git tag -a v0.0.12 <merge-commit> && git push origin v0.0.12
D7:           publica no npm a partir da tag (fora do escopo desta issue)
```

Nada de "owner mergeia" ou "sem revisor": merge só pelo orquestrador
(`.claude/rules/git-workflow.md` — regras invioláveis), sobre checks verdes
e `review:approved`, exatamente como qualquer outra PR. A única etapa
exclusiva do owner é criar a tag depois do merge — isso sim é intencional
(D7/gate humano de publicação, `docs/adr/0004-trabalho-autonomo.md` item 9),
porque o script nunca cria tag.

**Pendência de doutrina** (não corrigida por esta PR — `.claude/rules/`
não está nos `Files` da issue #531): o prefixo `release/<versão>`, que
`validateReleaseBranch` exige, ainda não está na tabela de prefixos de
branch de `.claude/rules/git-workflow.md`. Fica para uma PR própria do
orquestrador (a única classe autorizada a editar aquele arquivo).

## Antes da primeira release: a tag `v0.0.11`

Este repositório nunca teve uma tag (`git tag` vazio antes desta PR).
`CHANGELOG.md` já nasce com uma entrada `[0.0.11]` retroativa — todo o
histórico de merges até aqui, porque `lastReleaseTag` (abaixo) não tinha
nenhuma tag para usar como corte.

**Antes de abrir `release/0.0.12`**, o owner precisa criar `v0.0.11` sobre o
merge commit desta PR (`git tag -a v0.0.11 <sha> && git push origin
v0.0.11`). Sem essa tag, a primeira chamada real de `npm run release`
não tem nenhum `v*` para usar em `lastReleaseTag`, e `mergesSince(cwd,
null)` volta a varrer o histórico inteiro — o CHANGELOG de `0.0.12`
duplicaria as ~250 entradas que `[0.0.11]` já lista, em vez de conter só
os merges novos.

## O que o script recusa (e por quê)

| Causa                                            | Fase    | Quando                                                                               |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------ |
| `RELEASE_TREE_DIRTY`                             | COMPUTE | `git status --porcelain` não vazio                                                   |
| `RELEASE_INVALID_VERSION`                        | COMPUTE | argumento não é `patch`/`minor`/`major` nem `x.y.z`                                  |
| `RELEASE_PACKAGE_JSON_VERSION_MISSING`           | COMPUTE | `package.json` sem `version` string                                                  |
| `RELEASE_VERSION_NOT_GREATER`                    | COMPUTE | `x.y.z` explícito ≤ à versão atual (regressão de versão)                             |
| `RELEASE_BRANCH_MAIN`                            | COMPUTE | branch atual é `main`                                                                |
| `RELEASE_BRANCH_MISMATCH`                        | COMPUTE | branch atual não é `release/<versão-alvo>`                                           |
| `RELEASE_CHANGELOG_HEADER_UNEXPECTED`            | COMPUTE | `CHANGELOG.md` existe e não começa exatamente por `# Changelog\n`                    |
| `RELEASE_GIT_ADD_FAILED`/`RELEASE_COMMIT_FAILED` | WRITE   | `git add`/`git commit` falharam (stderr no erro) — depois que os arquivos já mudaram |

Toda causa de fase **COMPUTE** roda antes de qualquer escrita — uma recusa
aqui nunca deixa `package.json`/`package-lock.json`/`CHANGELOG.md`
alterados nem cria commit nenhum (os testes de `tests/release-script.test.ts`
pinam isso: conferem que `package.json`/`CHANGELOG.md` ficam bit a bit como
estavam e que `git status --porcelain` continua vazio depois da recusa).

As duas causas de fase **WRITE** (`RELEASE_GIT_ADD_FAILED`,
`RELEASE_COMMIT_FAILED`) são a exceção: nelas os arquivos JÁ foram escritos
em disco quando o `git add`/`git commit` falha — não há atomicidade
possível ali (o Node não tem transação sobre dois processos `git`
separados). Se isso acontecer, **não** rode `git checkout -- .`, `git
reset --hard` nem qualquer comando destrutivo, e **não** rode `npm run
release` de novo sem antes resolver a árvore — a validação
`RELEASE_TREE_DIRTY` da fase COMPUTE recusaria de imediato, porque o bump
anterior ficou modificado e sem commit. O operador inspeciona `git
status`/`git diff` e decide:

- se o conteúdo está correto (a causa mais provável é `git commit`
  recusado por um hook local): termina o commit manualmente
  (`git add -A && git commit -m "chore(release): v<versão>"`);
- se não está (escrita parcial, disco cheio, etc.): descarta deliberada e
  conscientemente as mudanças destas alterações específicas — nunca um
  `checkout .`/`reset --hard` genérico que também apagaria qualquer outra
  coisa não commitada que porventura exista na árvore — e roda `npm run
release` de novo a partir de uma árvore limpa.

## Referências

- `scripts/release.ts` — implementação (`parseVersionArg`,
  `computeNextVersion`, `mergesSince`, `buildChangelogSection`, `runRelease`).
- `tests/release-script.test.ts` — bancada com repositórios git temporários
  (`mkdtemp` + `git init`), sem rede.
- `docs/provenance.md` — o invariante de ancestralidade que a tag precisa
  respeitar (a tag fica sobre um commit de `main`, nunca sobre um commit
  isolado da branch de release).
- `docs/parity-validation.md:18` — de onde `version: 0.0.11` veio
  originalmente (herdada do Python pinado).
