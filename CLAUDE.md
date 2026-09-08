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
- `docs/adr/` — decisões arquiteturais; a 0003 define o wire-format próprio,
  a 0004 o trabalho autônomo (orquestrador mergeia com CI + revisor).
- Issues e milestones no GitHub registram o trabalho em andamento.

## Convenções

- TDD: teste primeiro, cobertura alta. Mutation testing (`npm run mutations:all`,
  fatias em `scripts/mutations/slices.json`; mecânicas, catálogo e contagem em
  `docs/mutation-testing.md`) é a evidência de que os testes prendem
  comportamento.
- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Arquivos pequenos (200–400 linhas típico, 800 max). Conventional commits.
- Fail-closed: exceção nunca é engolida silenciosamente (log ou propaga).
- Imutabilidade: nunca mutar estruturas compartilhadas; retornar cópias.
- Sem segredos no repo.
- `docs/reference/` é documentação histórica do Python — não editar; não é
  normativa.
- Gates (lista canônica; os outros documentos citam esta): `npm run build` →
  `typecheck` → `lint` → `format:check` → `test`, e `npm run prova -- <slug>`
  na branch de uma issue. O CI (`.github/workflows/ci.yml`) roda os mesmos em
  Node 20/22, verifica que todo SHA aprovado em `docs/provenance.json` é
  ancestral do HEAD (formato e script em `docs/provenance.md`) e, em PR, roda
  `escopo`, `contratos` e `controle-negativo`.
- Em sessões de Claude Code, `.claude/settings.json` formata e aplica
  `eslint --fix` a cada arquivo editado.
- Fluxo de git (issue-first, branch por issue, PR para `main`, sem
  force-push): `.claude/rules/git-workflow.md`. Quem mergeia e quando:
  `.claude/rules/orquestracao.md` e `docs/adr/0004-trabalho-autonomo.md`.
- Agentes de projeto (`.claude/agents/`): `implementador` (sonnet, worktree,
  TDD → PR, nunca mergeia), `revisor` (opus, só leitura, JSON; o
  orquestrador aplica a label), `qa` (suíte inteira + mutação em merge de
  risco; só reporta), `documentador` (docs pós-merge). Skill
  `worktree-segura` para quem escreve em worktree.

## Invariantes do runtime

Propriedades de engenharia deste runtime — durabilidade, trabalho limitado,
falha explícita — independentes de qualquer outra implementação:

1. System prompt construído uma vez por sessão e congelado; memória/skills
   mudam disco, nunca o prompt vivo.
2. Falha nunca é silenciosa — fault com causa em todo caminho.
3. Budget/fan-out nunca unbounded.
4. Escrita de estado cross-process sempre sob lease/fence.

## Artefatos históricos

Existem porque o repositório nasceu como port com paridade obrigatória. O
harness bilateral (`scripts/parity/`, 475 arquivos, 70 scripts npm com
prefixo `parity`/`probe`) foi apagado em #167 (PR #212, 2026-09-08);
inventário completo da perda em `docs/regression-inventory.md`. Nenhum
artefato listado abaixo é requisito hoje:

- `lohra/` e o venv do Python pinado associado — gitignorados, opcionais,
  somente leitura no disco de quem trabalha; nome e procedimento (histórico)
  em `docs/parity-validation.md`.
- `docs/reference/` e `docs/parity-validation.md` — documentação e
  procedimento bilateral de aceite; históricos.

A definição executável do comportamento hoje é `tests/**` e
`tests/fixtures/**`.
