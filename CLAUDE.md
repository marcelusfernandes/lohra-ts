# lohra-ts

Runtime de agente em TypeScript e **linha principal** do produto
(`typescript-mainline`, ver `docs/gate-decision-t22.md`).

Desde **2026-09-04**, por decisão do owner, o desenvolvimento é **independente
do Lohra Python** (`github.com/marcelusfernandes/lohra`). O Python é referência
histórica, não oracle: nada precisa ser confirmado contra ele antes de
implementar, e nenhuma saída deste runtime precisa reproduzir bytes dele
(`docs/adr/0003-native-wire-format.md`).

**IMPORTANTE:** não se implementa nada em `lohra/`. O checkout é gitignorado,
opcional e somente leitura.

## Meta de produto

Núcleo headless orientado a eventos → **TUI** (Ink) → **GUI Electron**
(Mac + Windows). TUI e GUI são renderers do mesmo protocolo de eventos.

## Decisões já tomadas

- `docs/gate-decision-t22.md` — lohra-ts é a mainline (2026-09-03).
- `docs/adr/` — decisões arquiteturais; a 0003 define o wire-format próprio.
- Issues e milestones no GitHub registram o trabalho em andamento.

## Convenções

- TDD: teste primeiro, cobertura alta. Mutation testing (`npm run mutations:*`)
  é a evidência de que os testes prendem comportamento.
- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Arquivos pequenos (200–400 linhas típico, 800 max). Conventional commits.
- Fail-closed: exceção nunca é engolida silenciosamente (log ou propaga).
- Imutabilidade: nunca mutar estruturas compartilhadas; retornar cópias.
- Sem segredos no repo.
- `docs/reference/` é documentação histórica do Python — não editar; não é
  normativa.
- Gates: `npm run typecheck`, `lint`, `format:check`, `test`; o CI
  (`.github/workflows/ci.yml`) roda os mesmos em Node 20/22 e verifica que
  todo SHA aprovado em `docs/closeout.md` é ancestral do HEAD.
- Em sessões de Claude Code, `.claude/settings.json` formata e aplica
  `eslint --fix` a cada arquivo editado.
- Fluxo de git (issue-first, branch por issue, PR para `main`, sem
  force-push): `.claude/rules/git-workflow.md`.

## Invariantes do runtime

Propriedades de engenharia deste runtime — durabilidade, trabalho limitado,
falha explícita — independentes de qualquer outra implementação:

1. System prompt construído uma vez por sessão e congelado; memória/skills
   mudam disco, nunca o prompt vivo.
2. Falha nunca é silenciosa — fault com causa em todo caminho.
3. Budget/fan-out nunca unbounded.
4. Escrita de estado cross-process sempre sob lease/fence.

## Artefatos históricos

Existem porque o repositório nasceu como port com paridade obrigatória. Nenhum
deles é requisito hoje:

- `lohra/` e `.oracle-venv/` — checkout e venv do Python pinado; gitignorados,
  opcionais.
- `docs/reference/` e `docs/parity-validation.md` — documentação e procedimento
  bilateral de aceite; históricos.
- Scripts `parity:*`/`probe:*` e as fixtures capturadas — hoje a definição
  executável do comportamento; a migração para `regression:*` é issue própria.
