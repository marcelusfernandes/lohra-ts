# Orquestração — o laço

Como uma sessão principal (o **orquestrador**) conduz o trabalho do repositório
sem humano no loop. Decisão em `docs/adr/0004-trabalho-autonomo.md`; regras de
git em `git-workflow.md`. Quem age e qual gate existe em cada passo.

| #   | passo                                                                                                                                                                                                                                    | quem           | gate                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------- |
| 0   | **Reconciliar com o GitHub**, nunca com a memória: PRs abertas, `state:*`, branches ligadas, worktrees locais                                                                                                                            | orquestrador   | —                                  |
| 1   | Decompor a issue-mãe do milestone em sub-issues (AC, `Proof`, `Files`, dependências) com a skill `issue`                                                                                                                                 | orquestrador   | —                                  |
| 2   | Escolher até 4 issues `state:ready` sem dependência aberta e sem interseção de `Files`                                                                                                                                                   | orquestrador   | —                                  |
| 3   | `gh issue develop <n> --base main --name <type>/<n>-<slug>` — o push da ref nova é o lock; `state:in-progress`                                                                                                                           | orquestrador   | lock atômico do git                |
| 4   | Lançar o `implementador` em worktree isolado                                                                                                                                                                                             | orquestrador   | —                                  |
| 5   | Teste vermelho primeiro, commit `test(red):`; implementar até verde, commit a cada verde                                                                                                                                                 | implementador  | Stop hook (`tsc` + prova por slug) |
| 6   | Gates locais (os cinco do CLAUDE.md) e `npm run prova -- <slug>`, e **dogfooding real** se tocou `src/`/`package.json`/lockfile (senão `N/A` com motivo)                                                                                 | implementador  | —                                  |
| 7   | Push e PR pela skill `pr` (`Closes #N`, AC copiados, `state:in-review`). **Para. Nunca mergeia.**                                                                                                                                        | implementador  | —                                  |
| 8   | CI: `checks (20)`, `checks (22)`, `provenance`; em PR também `escopo`, `contratos` e `controle-negativo`                                                                                                                                 | GitHub Actions | required checks                    |
| 9   | `revisor` (só leitura) avalia: AC × diff, escopo, controle negativo, invariantes, qualidade → JSON (resposta final)                                                                                                                      | revisor        | —                                  |
| 9a  | Para cada item de `blocking`, até 3 `revisor` em modo cético (`REFUTAR:` + nº da PR, lentes `correcao`/`reproducao`/`escopo`); o item cai só com ≥2 `refuted: true`; sem cético (teto de 9 por rodada) permanece bloqueante (#146)       | orquestrador   | fan-out bounded                    |
| 9b  | Comentar o veredito na PR — com `refutation: [{finding, refuted: n/3}]` e o `verdict` recomputado a partir do `blocking` que sobreviveu, se houve 9a — e aplicar a label: `approved` → `review:approved`; `rejected` → `state:qa-failed` | orquestrador   | label = rastro do veredito         |
| 10a | Checks verdes + `review:approved` → **merge commit** (`gh pr merge --merge`) → `state:done`                                                                                                                                              | orquestrador   | nenhum humano                      |
| 10b | Reprovado → volta ao implementador com as `reasons` (rodada 2, mesmo worktree)                                                                                                                                                           | implementador  | —                                  |
| 10c | Conflito com `main` → `git merge origin/main` na branch publicada; nunca rebase publicado                                                                                                                                                | implementador  | —                                  |
| 10d | **Segunda reprovação** → `state:blocked` + `human`, comentário com o resumo; orquestrador segue para outra                                                                                                                               | orquestrador   | **gate humano**                    |
| 11  | Merge de risco (toca `src/state/`, `src/workflow/`, `.github/`) → `qa` roda suíte inteira + `mutations:*`                                                                                                                                | qa             | só reporta, nunca corrige          |
| 12  | Merge que muda decisão, contrato ou comando → `documentador` abre PR de classe `docs` (`docs/**`, README; sem revisor)                                                                                                                   | documentador   | CI                                 |
| 13  | Remover o worktree **depois** do merge, nunca antes                                                                                                                                                                                      | orquestrador   | —                                  |
| 14  | Passada sem nada a fazer → resumo dos `blocked` na issue-mãe; milestone sem issue aberta → próximo milestone                                                                                                                             | orquestrador   | —                                  |

## Estados

```
state:ready → state:in-progress → state:in-review → state:done
                                       ↓ reprovou
                                  state:qa-failed → (rodada 2) → state:in-review
                                       ↓ reprovou de novo
                                  state:blocked + human
```

`review:approved` só o orquestrador põe, sobre um veredito `approved` do
revisor comentado na PR. `human` só sai quando a pessoa resolve.

## Gates humanos (lista fechada, ADR 0004 item 9)

ADRs (OK explícito), segredos e variáveis, ruleset/proteção da `main`,
publicação no registry, qualquer `state:blocked`, apagar branch ou reescrever
histórico. Fora disso, ninguém espera ninguém.

## O que o orquestrador nunca faz

Implementar (delega); mergear sem as duas condições; `gh pr merge --admin`;
squash; rebase de branch publicada; confiar na memória em vez do GitHub;
continuar iterando depois da segunda reprovação.
