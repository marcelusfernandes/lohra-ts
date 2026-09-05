# Git workflow

Regras do repositório para pessoas e agentes. Carregadas automaticamente em
sessões de Claude Code; valem para qualquer outro harness que leia `.claude/`.

## Issue-first

Toda branch de feature, fix ou refactor não trivial traça de volta a uma issue.
Sem issue, não começa.

1. **Buscar** issue existente:
   `gh issue list --repo marcelusfernandes/lohra-ts --search "<palavras>"`.
2. **Sem match → criar** com a skill `issue` (padrão de seções, milestone,
   labels, parent).
3. **Se for M ou L** — ou se o diff projetado passar de ~2k linhas fora de
   lockfile e fixtures — **não começar**: virar épico e decompor em sub-issues
   menores, cada uma com User Story e AC próprios, cada uma com sua PR.
4. **Branch a partir da issue**, para o vínculo aparecer no painel Development:
   `gh issue develop <n> --base main --name <type>/<slug> --checkout`

Se alguém pedir para pular ("é pequeno", "depois eu crio"), o assistente
sinaliza o gate ("criando a issue de tracking primeiro") e cumpre. Exceção
seletiva vira nenhuma exceção.

**Exceções** (não precisam de issue): correção de typo; edição de um arquivo com
menos de 50 linhas e baixa carga cognitiva; comandos exploratórios ou de
leitura.

## Modelo de branch

- `main` — trunk único. Atualizada **somente** por PR.
- `<type>/<slug>` — toda mudança, criada a partir de `main`.

Não existe `develop`. Se um dia existir, o fechamento automático de issues
precisa do workflow `close-linked-issues` (o `Closes #N` nativo só dispara em
merge na branch default).

As branches `traycer/tNN-*` são legado do processo anterior (ver #14); não
criar novas nesse padrão.

## Nome de branch

Slug em kebab-case, prefixo igual ao tipo do conventional commit:

| Prefixo     | Uso                                 |
| ----------- | ----------------------------------- |
| `feat/`     | Funcionalidade nova                 |
| `fix/`      | Correção de bug                     |
| `refactor/` | Reestrutura sem mudar comportamento |
| `perf/`     | Otimização                          |
| `chore/`    | Deps, config, tooling               |
| `docs/`     | Só documentação                     |
| `test/`     | Só testes                           |
| `ci/`       | CI, GitHub Actions, hooks           |

Exemplos: `feat/workflow-store`, `fix/stub-driver-port`, `docs/adr-0004`.

## Fluxo de uma mudança

1. `git checkout main && git pull`
2. `gh issue develop <n> --base main --name <type>/<slug> --checkout`
3. Implementar e commitar na branch (TDD; gates locais verdes).
4. **Aguardar a pessoa confirmar** que está bom.
5. Só então: `git push -u origin <type>/<slug>` e abrir a PR com a skill `pr`.
6. Parar. A pessoa revisa e decide o merge.

## Commit

`<type>(<escopo opcional>): <descrição imperativa, minúscula, sem ponto>`

Tipos: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
Corpo explica o porquê. Rodapé com `Closes #N` (ou `Refs #N` quando não
fecha). Idioma: PT-BR, como o resto do repositório.

## PR

- Base sempre `main`.
- Body no template (`.github/PULL_REQUEST_TEMPLATE.md`): Resumo, `Closes #N`,
  Test plan, Acceptance Criteria copiados da issue.
- **`Closes #N` em texto puro** — sem negrito nem itálico. O parser do GitHub
  não reconhece `Closes **#N**` e a issue fica aberta depois do merge.
- Labels e milestone iguais aos da issue.
- Verificar depois de criar:
  `gh pr view <n> --json closingIssuesReferences,labels,milestone`
  Se algum campo vier vazio, completar antes de pedir review.

## Milestones

- Um milestone por tema ou wave: título `Tema: subtítulo`, descrição com o
  objetivo e o **critério de saída** (o que precisa ser verdade para fechar).
- Sub-issues herdam o milestone do épico.
- O header `Tamanho` de cada issue vira a label `complexity:S|M|L`.
- `severity:*` vem de review independente e **não** determina ordem de roadmap.

## Regras invioláveis

- Nunca começar trabalho sem issue rastreável (exceções acima).
- Nunca commitar direto em `main`.
- Nunca fazer merge de PR — a pessoa revisa e decide.
- Não fazer push da branch antes da confirmação da pessoa.
- **Nunca force-push.** O hook `.claude/hooks/block-force-push.sh` nega na
  sessão; a proteção server-side da `main` é o backstop. Reescrever histórico
  quebra o invariante de proveniência (`docs/closeout.md`, job `provenance`).
- Nunca `Closes **#N**` — texto puro.
