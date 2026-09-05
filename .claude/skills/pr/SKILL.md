---
name: pr
description: Abre a pull request de uma branch do lohra-ts contra a `main`, já ligada à issue — `Closes #N` em texto puro, Acceptance Criteria copiados da issue como checklist, labels e milestone herdados, e verificação pós-criação via `gh pr view --json`. Use quando o usuário pedir "abre a PR", "cria PR", "sobe isso pra review", ou depois de confirmar que a implementação de uma issue está pronta. NÃO use para mergear, nem antes de o usuário confirmar o push (regra em .claude/rules/git-workflow.md).
argument-hint: '--issue N [--title "…"] [--dry-run]'
allowed-tools: Bash, Read, Grep
user-invocable: true
---

# /pr — pull request ligada à issue

## Pré-condições (gates, não passos)

1. Gates locais verdes e dogfooding feito (abaixo). Não há confirmação
   humana no caminho normal (ADR 0004): o revisor e o CI são os gates.
2. A branch traça de volta a uma issue (`--issue N`, ou inferida do painel
   Development se a branch foi criada com `gh issue develop`).
3. Gates locais verdes: `npm run typecheck`, `lint`, `format:check`, `test`.
4. **Dogfooding real feito e positivo**, quando possível: uma execução de
   verdade do runtime (Codex e/ou OpenRouter) com exit 0, `error: null` e
   `tool_calls` quando a tarefa exige tool. Vai no Test plan da PR.

## Passos

1. `git push -u origin <branch>` se ainda não publicada.
2. Rodar o script — ele lê a issue, monta o body no template
   (`.github/PULL_REQUEST_TEMPLATE.md`), garante `Closes #N` em texto puro,
   copia os Acceptance Criteria como checklist, cria com `gh pr create
--base main`, aplica labels e milestone da issue, e **verifica**:

   ```bash
   .claude/skills/pr/scripts/open-pr.sh --issue <N> [--title "<título>"] [--dry-run]
   ```

   A verificação (`gh pr view --json closingIssuesReferences,labels,milestone`)
   falha o script se a issue não aparecer em `closingIssuesReferences` — isso
   é o que garante o fechamento automático no merge.

3. Marcar no body os AC que foram atendidos; o que não foi fica explícito.
4. Aplicar `state:in-review` na issue; reportar a URL e parar. **Quem
   implementa nunca mergeia** — o orquestrador mergeia quando CI verde e
   `review:approved` (`.claude/rules/orquestracao.md`).

## Regras

- `Closes #N` sempre em texto puro; `Closes **#N**` não fecha a issue.
- Base sempre `main`. Título em Conventional Commits, PT-BR.
- Labels e milestone iguais aos da issue.
- Uma PR por issue; se a branch resolve mais de uma, uma linha `Closes #N`
  por issue.
