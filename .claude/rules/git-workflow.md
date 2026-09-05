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
   `gh issue develop <n> --base main --name <type>/<n>-<slug> --checkout`
   O push da ref nova falha se ela já existir — **é o lock da issue** (ADR
   0004 item 2). `<n>` liga branch, issue e slug de prova.

Se alguém pedir para pular ("é pequeno", "depois eu crio"), o assistente
sinaliza o gate ("criando a issue de tracking primeiro") e cumpre. Exceção
seletiva vira nenhuma exceção.

**Exceções** (não precisam de issue): correção de typo; edição de um arquivo com
menos de 50 linhas e baixa carga cognitiva; comandos exploratórios ou de
leitura.

## Modelo de branch

- `main` — trunk único. Atualizada **somente** por PR.
- `<type>/<n>-<slug>` — toda mudança, criada a partir de `main`.

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

Sempre `<type>/<n>-<slug>`, com `<n>` = número da issue. Exemplos:
`feat/12-workflow-store`, `fix/3-stub-driver-port`, `docs/31-adr-0004`.

## Fluxo de uma mudança

1. `git checkout main && git pull`
2. `gh issue develop <n> --base main --name <type>/<n>-<slug> --checkout`
   (a issue recebe `state:in-progress`)
3. Implementar e commitar na branch: teste vermelho primeiro (`test(red):`),
   depois verde, commit a cada verde. Gates locais verdes.
4. **Dogfooding real**: obrigatório quando a branch toca `src/`, `package.json`
   ou o lockfile — exercitar o runtime de verdade (`lohra chat --json` via
   Codex e/ou OpenRouter com uma tarefa que use tool) e registrar exit code,
   `error` e `tool_calls` no test plan. Quando não toca, o test plan declara
   `N/A` com o motivo. Testes verdes são necessários, não suficientes.
5. Push e PR pela skill `pr` (`Closes #N`, AC copiados, `state:in-review`).
   Quem implementa **para aqui** — nunca mergeia.
6. O orquestrador lança o `revisor` (só leitura, nunca aplica label). O
   veredito vai em JSON como comentário na PR; o orquestrador aplica
   `review:approved` se `approved`, ou `state:qa-failed` se `rejected` e volta
   ao passo 3 com as `reasons`.
7. **Merge pelo orquestrador**, só quando as duas condições mecânicas valem:
   todos os checks obrigatórios verdes no HEAD da PR **e** `review:approved`.
   Merge commit (`gh pr merge --merge`), nunca squash — o job `provenance`
   verifica ancestralidade. `Closes #N` fecha a issue.
8. Segunda reprovação → `state:blocked` + `human`; o orquestrador segue para
   outra issue. Daí em diante é a pessoa.

O laço completo, com quem age em cada passo: `orquestracao.md`.

## Commit

`<type>(<escopo opcional>): <descrição imperativa, minúscula, sem ponto>`

Tipos: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
Corpo explica o porquê. Rodapé com `Closes #N` (ou `Refs #N` quando não
fecha); `(#N)` no fim do assunto vale como `Refs #N`. Idioma: PT-BR, como o
resto do repositório.

## PR

- Base sempre `main`.
- Body no template (`.github/PULL_REQUEST_TEMPLATE.md`): Resumo, `Closes #N`,
  Test plan, Acceptance Criteria copiados da issue.
- **`Closes #N` em texto puro** — sem negrito nem itálico. O parser do GitHub
  não reconhece `Closes **#N**` e a issue fica aberta depois do merge.
- Labels de tipo (`bug`, `enhancement`, …) e `complexity:*` e milestone iguais
  aos da issue; `state:*`, `epic`, `human` e `review:*` ficam na issue — a skill
  `pr` filtra, e `review:approved` na PR é o rastro do veredito.
- Verificar depois de criar:
  `gh pr view <n> --json closingIssuesReferences,labels,milestone`
  Se algum campo vier vazio, completar antes de pedir review.

## Milestones

- Um milestone por tema ou wave: título `Tema: subtítulo`, descrição com o
  objetivo e o **critério de saída** (o que precisa ser verdade para fechar).
- Sub-issues herdam o milestone do épico.
- O header `Tamanho` de cada issue vira a label `complexity:S|M|L`.
- `severity:*` vem de review independente e **não** determina ordem de roadmap.
- Estado: `state:ready → in-progress → in-review → done`; `state:qa-failed`
  volta ao implementador; `state:blocked` + `human` após duas reprovações.
  `review:approved` só o orquestrador põe, e só sobre um veredito `approved`
  do revisor registrado na PR.

## Regras invioláveis

- Nunca começar trabalho sem issue rastreável (exceções acima).
- Nunca commitar direto em `main`.
- Merge só pelo orquestrador, só com checks verdes **e** `review:approved`;
  nunca `gh pr merge --admin`; nunca squash.
- Quem implementa nunca mergeia; quem revisa nunca edita.
- Push só depois dos gates locais e do dogfooding (ou do `N/A` declarado).
- Nunca `git reset --hard`, `git clean` nem `git checkout <arquivo>` sobre
  trabalho não commitado — perdem o que não foi salvo. `git stash` é permitido.
- Depois da segunda reprovação, ninguém insiste: `state:blocked` + `human`.
- **Nunca force-push.** Quatro camadas (`.claude/hooks/README.md`): `protege-main.sh`
  nega na sessão, o `pre-push` nativo nega em qualquer push da máquina, o ruleset
  nega no servidor, e `guarda-main.yml` abre issue `human` no que escapar. Reescrever histórico
  quebra o invariante de proveniência (`docs/closeout.md`, job `provenance`).
- Nunca `Closes **#N**` — texto puro.
