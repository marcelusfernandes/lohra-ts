# Markdown de skill é doutrina — classe `docs` no `controle-negativo`

- **Data:** 2026-09-10
- **Origem:** PR #344 (issue #343), reprovada pelo `controle-negativo` por
  editar só `assets/skills/workflow-authoring/SKILL.md`; issue #345 (sub-issue
  do épico de hardening #229).

## Contexto

`scripts/ci/controle-negativo/lib.ts:189-215` define a classe `docs`/`process`
da ADR 0004 item 7 — arquivos que este check não precisa controlar, porque uma
PR só de documentação ou de configuração de CI não tem como declarar
`prova/<slug>.ts` (não há comportamento novo para provar vermelho). Antes
desta nota, a classe era `DOCS_TOPO` (`README.md`, `CLAUDE.md`, `AGENTS.md`,
`.worktreeinclude`) mais os prefixos `docs/`, `.claude/`, `.github/`,
`scripts/github/` (`DOCS_OU_PROCESS_PREFIXOS`).

`assets/**` ficava inteiramente fora — com razão para código: `assets/` (por
exemplo `assets/skills/**/index.ts` ou outros arquivos não-markdown) é
artefato exportado ao produto, exatamente o tipo de mudança que este check
existe para controlar. Mas o markdown de doutrina de uma skill
(`assets/skills/<nome>/SKILL.md` e o que estiver sob o mesmo diretório, como
`references/*.md`) é prosa igual a `docs/**` — não tem asserção que fique
vermelha na base. A PR #344 reprovou por "PR sem prova declarada" mesmo
editando só esse markdown.

## Decisão

- `assets/skills/**/*.md` (qualquer profundidade sob `assets/skills/`, só
  arquivos `.md`) entra na classe `docs`/`process` de
  `ehArquivoDocsOuProcess` (`scripts/ci/controle-negativo/lib.ts`) — o único
  predicado consumido por todos os pontos que decidem SKIP: `deveSerIgnorado`
  (SKIP total), `soDeclaracaoDeProvaExistenteEditada` e `semDocsOuProcess`
  (usada por `ehDiffSoDoOverlay`/`soArquivosDoOverlay`). Não há segundo lugar
  no código que reimplemente a classificação.
- `assets/**` fora de `assets/skills/`, e qualquer arquivo não-markdown
  dentro de `assets/skills/` (por exemplo `index.ts`), continuam fora da
  classe — feature de verdade, controle normal.
- O hook `protege-main.sh` tem sua própria noção de classe docs e não inclui
  `assets/skills/**/*.md` — esta nota refina só a classificação do
  `controle-negativo` (CI); uma PR só de markdown de skill continua exigindo
  revisor normalmente.

### Por que isso é refinamento, não mudança de ADR

A ADR 0004 item 7 já define a classe `docs` por globs de caminho, sem listar
exaustivamente todo caminho possível; `assets/skills/**/*.md` é o mesmo tipo
de arquivo (prosa/doutrina, não comportamento) só que fora do prefixo
`docs/`. Nada na promessa da ADR muda — nenhuma classe de PR passa a mergear
sem revisor, e o critério ("PR de doutrina não precisa de teste vermelho")
continua idêntico.

## Doutrina para autores de spec

Uma skill nova ou editada cujo diff toca só `SKILL.md`/`references/*.md` (sob
`assets/skills/`) não precisa de `prova/<slug>.ts` nem de `test(red):` — o
`controle-negativo` faz SKIP. Um `assets/skills/<nome>/index.ts` (ou
qualquer código que a skill exporte) continua exigindo prova normal, mesmo
que o `SKILL.md` da mesma skill mude junto — a classe é por arquivo, e uma PR
que mistura as duas classes segue a mais estrita (a que exige controle).

## Evidência

- `tests/ci-controle-negativo.test.ts`, describe `ehArquivoDocsOuProcess /
deveSerIgnorado`: `assets/skills/x/SKILL.md` → docs;
  `assets/skills/workflow-authoring/references/campos.md` → docs;
  `assets/skills/x/index.ts` → não-docs; `assets/other/README.md` → não-docs
  (só `assets/skills/` conta); `src/assets/skills/x/SKILL.md` (fora da raiz
  do repo) e `assets/skills/x/SKILL.mdx` (extensão errada) → não-docs;
  `deveSerIgnorado(["assets/skills/a/SKILL.md"])` → SKIP.

## Apêndice (2026-09-12): `lefthook.yml` na classe `process` (issue #555)

- **Origem:** PR #554 (D9/#544, follow-up de #530) precisou tirar
  `lefthook.yml` do diff porque a PR era só de prosa de processo (correção
  do comentário do cabeçalho) e o `controle-negativo` reprovava por "PR sem
  prova declarada" — o mesmo sintoma da PR #344 que originou esta nota, só
  que para um arquivo de configuração de hook, não de doutrina de skill.
- **Decisão:** `lefthook.yml` (config do pre-commit local, mesma natureza de
  `.claude/hooks/*`) entra em `DOCS_TOPO` — a mesma lista de
  `README.md`/`CLAUDE.md`/`AGENTS.md`/`.worktreeinclude` em
  `ehArquivoDocsOuProcess` (`scripts/ci/controle-negativo/lib.ts`). É
  configuração de processo de repositório, nunca comportamento do runtime a
  controlar.
- **Correção junto:** o cabeçalho de `lefthook.yml:1-9` dizia que os hooks
  eram instalados por `scripts/postinstall.mjs` — desde D1/#530 é
  `scripts/prepare.mjs`, com o guard `LOHRA_SKIP_PREPARE=1` (issue #544).
  Prosa desatualizada corrigida junto.
- **Evidência:** `tests/ci-controle-negativo.test.ts`,
  `ehArquivoDocsOuProcess("lefthook.yml")` → `true`;
  `deveSerIgnorado(["lefthook.yml", ".claude/x"])` → SKIP;
  `deveSerIgnorado(["lefthook.yml", "src/x.ts"])` → controle normal (mistura
  com produção não faz SKIP).
