# Release

Como cortar uma versão publicável de `lohra-ts` (issue #531, D2 do épico
#529 — "Distribuição pública"). `scripts/release.ts` (`npm run release --
<patch|minor|major|x.y.z>`) faz o bump e o commit; a tag e a publicação são
passos separados, feitos por outra pessoa/processo.

## O que o script faz

1. Valida a árvore de trabalho limpa (`git status --porcelain` vazio) —
   recusa com `RELEASE_TREE_DIRTY` senão.
2. Valida o argumento: `patch`, `minor`, `major` ou um `x.y.z` explícito —
   qualquer outra coisa recusa com `RELEASE_INVALID_VERSION`.
3. Lê `version` de `package.json`, computa a versão-alvo (bump ou o
   `x.y.z` explícito).
4. Valida a branch atual: precisa ser exatamente `release/<versão-alvo>`.
   `main` recusa com a causa própria `RELEASE_BRANCH_MAIN`; qualquer outra
   branch (inclusive `release/<versão errada>`) recusa com
   `RELEASE_BRANCH_MISMATCH`.
5. Faz o bump em `package.json` (`version`) e, se `package-lock.json`
   existir, nas duas ocorrências do pacote raiz do lockfile (`version` de
   topo e `packages[""].version`) — nunca nas `version` das dependências
   (`node_modules/**` dentro de `packages`), que ficam intactas.
6. Gera a seção do `CHANGELOG.md` para a versão-alvo a partir dos merges de
   PR (`git log --first-parent --merges`, ver abaixo) e a insere no topo do
   arquivo, logo após o cabeçalho `# Changelog`.
7. `git add package.json CHANGELOG.md [package-lock.json]` +
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

```
owner: git checkout -b release/0.0.12 main
owner: npm run release -- patch          # ou minor/major/x.y.z
owner: git push -u origin release/0.0.12
owner: abre PR release/0.0.12 -> main (título chore(release): v0.0.12)
CI:    checks + provenance (release é PR normal, sem revisor específico)
owner: gh pr merge --merge                # merge commit, nunca squash
owner: git tag -a v0.0.12 <merge-commit> && git push origin v0.0.12
D7:    publica no npm a partir da tag (fora do escopo desta issue)
```

A PR de release passa pelo mesmo CI que qualquer outra (`checks`,
`provenance`, `escopo`, `contratos`, `controle-negativo` — o diff é só
`package.json`/`package-lock.json`/`CHANGELOG.md`, então `contratos` e
`controle-negativo` não têm o que reprovar). Não precisa de revisor de
conteúdo: o script já valida o que importa (branch, árvore, versão).

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

| Causa                                              | Quando                                              |
| -------------------------------------------------- | --------------------------------------------------- |
| `RELEASE_TREE_DIRTY`                               | `git status --porcelain` não vazio                  |
| `RELEASE_INVALID_VERSION`                          | argumento não é `patch`/`minor`/`major` nem `x.y.z` |
| `RELEASE_BRANCH_MAIN`                              | branch atual é `main`                               |
| `RELEASE_BRANCH_MISMATCH`                          | branch atual não é `release/<versão-alvo>`          |
| `RELEASE_PACKAGE_JSON_VERSION_MISSING`             | `package.json` sem `version` string                 |
| `RELEASE_GIT_ADD_FAILED` / `RELEASE_COMMIT_FAILED` | `git add`/`git commit` falharam (stderr no erro)    |

Todas as validações rodam antes de qualquer escrita — uma recusa nunca
deixa `package.json`/`package-lock.json`/`CHANGELOG.md` parcialmente
alterados nem cria um commit incompleto.

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
