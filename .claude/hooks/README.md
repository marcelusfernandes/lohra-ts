# Hooks — proteção da `main` em quatro camadas

Decisão em `docs/adr/0004-trabalho-autonomo.md` (itens 4 e 9). Todos os hooks
parseiam o stdin com **node** (pré-requisito do projeto) — sem `jq`; `protege-*`
são **fail-closed** se node faltar (o `stop-gate.sh` é **fail-open**: avisa e
segue, porque o agente não tem como instalar node encerrando ou não o turno). Portados do Apollo (`tacit-wl/apollo`). O
repositório é público desde 2026-09-05, então a camada 3 é um ruleset real.

| camada | peça                                       | onde vale                         | o que faz                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `protege-main.sh` (PreToolUse Bash)        | sessões Claude Code               | nega force-push (sem válvula), push em `main`, apagar `main`, `gh pr merge --admin` (sem válvula), `gh pr merge` sem checks verdes + `review:approved`                                                                                                                                    |
| 1      | `protege-escrita.sh` (PreToolUse Edit)     | sessões Claude Code               | nega escrita em `docs/reference/**` e `lohra/**`; resolve symlink que escapa                                                                                                                                                                                                              |
| 1      | `stop-gate.sh` (Stop)                      | sessões Claude Code               | tsc + `npm run prova -- <slug>` da branch; exit 2 até a prova ficar verde; **fail-open** sem node (avisa e segue); bancada em `tests/stop-gate.test.ts`                                                                                                                                   |
| 2      | `git-pre-push` (hook git nativo)           | qualquer `git push` desta máquina | recusa push em `main` e push não fast-forward; instalado por `instalar-git-hooks.sh` via `postinstall`                                                                                                                                                                                    |
| 3      | ruleset da `main` (GitHub)                 | servidor                          | PR obrigatória, seis checks required (`checks (20)`, `checks (22)`, `provenance`, `escopo`, `contratos`, `controle-negativo` — #60), só merge commit, sem force-push, sem delete — `scripts/github/ruleset.sh` (aplicado em 2026-09-05 com três checks; reaplicar com seis é gate humano) |
| 4      | `guarda-main.yml` (Action)                 | servidor, pós-push                | commit em `main` sem PR → issue `human` + job falha                                                                                                                                                                                                                                       |
| —      | `format-file.sh` (PostToolUse Edit\|Write) | sessões Claude Code               | prettier + `eslint --fix` no arquivo editado; nunca bloqueia                                                                                                                                                                                                                              |

## Stop gate (`stop-gate.sh`, issue #43)

Roda no fim de cada turno do agente; exit 2 impede o encerramento ("loop until
green"). Substituiu o `tsc-check.sh`.

1. `tsc --noEmit` sempre (sem `node_modules/.bin/tsc` avisa e segue).
2. `npm run prova -- <slug>` com o slug da branch `<type>/<n>-<slug>` (mesma
   regra de `scripts/prova/slug.ts`, #42). Prova vermelha → exit 2 com
   `.prova/<slug>/resumo.json` no stderr. **Não bloqueia** quando a branch está
   fora do padrão (`main`, worktree de agente), quando o último commit começa
   com `test(red):` (controle negativo: a prova deve estar vermelha) ou quando
   não existe `prova/<slug>.ts` (ausência de declaração ≠ prova vermelha).

Raiz = toplevel git do `cwd` do payload (funciona em worktree de agente).

**Bancada** (`tests/stop-gate.test.ts`): `LOHRA_BENCH=1` é o único portão que
habilita as seams `LOHRA_STOP_BRANCH`, `LOHRA_STOP_LAST_COMMIT_MSG`,
`LOHRA_STOP_TSC_CMD`, `LOHRA_STOP_PROVA_CMD`; sem ele nenhuma é lida.
**Reentrância**: o filho da prova recebe `LOHRA_STOP_GATE_ACTIVE=1` e o hook sai
0 ao encontrá-la (fora da bancada) — uma prova que exercite hooks não recursa.
**Hermeticidade**: o filho nunca herda outra `LOHRA_STOP_*` nem `LOHRA_BENCH`.
**Teto**: lê `stop_hook_active`; no terceiro bloqueio consecutivo libera o turno
(seção "Bancada").

## Bancada (issue #61)

Cada hook tem bancada em vitest que o invoca em subprocesso com payload
sintético e afirma exit code e stderr: `tests/protege-main.test.ts`,
`tests/protege-escrita.test.ts`, `tests/stop-gate.test.ts` — declaradas em
`prova/bancada-hooks.ts` (`npm run prova -- bancada-hooks`). `LOHRA_BENCH=1` é
o único portão das seams (`LOHRA_PM_*` no protege-main, `LOHRA_STOP_*` no
stop-gate); sem ele os hooks consultam `git`/`gh` de verdade. O
`protege-escrita` não tem seam: a bancada monta um repo temporário com
`.claude/settings.json`, `lohra/` aninhado e um worktree em `.claude/worktrees/`.

**Waiver de classe `docs`** (`protege-main`, item 6): se todos os arquivos da PR
são `docs/**`, `README.md`, `CLAUDE.md` ou `AGENTS.md`, a label
`review:approved` é dispensada (avisado no stderr); checks verdes continuam
obrigatórios. O `gh` devolve no máximo 100 arquivos: se `changedFiles` for
maior que a lista, o waiver não se aplica (fail-closed). `LOHRA_MERGE_LIVRE=1`
deixa de ser necessário para PR de docs.

**Raiz do `protege-escrita`**: toplevel git mais interno, a partir do alvo, que
contenha `.claude/settings.json` — worktree de agente é raiz própria; `lohra/`
(repo aninhado sem settings) cai na raiz do projeto. Alvo que resolve para fora
de qualquer repo é permitido (scratchpad), salvo quando o caminho textual está
dentro da raiz do cwd — symlink que foge — que é negado. **Limitação
declarada** (#77): com o cwd fora de qualquer repositório e sem
`CLAUDE_PROJECT_DIR`, não há raiz para comparar, e um alvo que resolve por
symlink para fora de qualquer repo é permitido — o caso não ocorre numa sessão
aberta no repo, que é o único cenário suportado.

**Teto do `stop-gate`**: três bloqueios consecutivos da prova (payload
`stop_hook_active`) liberam o turno com aviso; contador em
`.prova/.stop-gate-bloqueios`, zerado por prova verde ou turno novo.

## Limite do parser (declarado)

`protege-main.sh` lê comandos em **posição de comando** — início, ou depois de
`; | & && || ( ) { }` crase e quebra de linha — com os prefixos `VAR=x`, `sudo`,
`env`, `command`, `builtin`, `exec`, `time`, `nohup`, `nice`, `\`, e as palavras
`if/elif/while/until/then/do/else/!`. **Evasão deliberada** (`eval`, `sh -c`,
variáveis, aliases, scripts) está fora do escopo deste hook e é backstop das
camadas 2–4. Falso positivo em texto como dado depois de um separador (heredoc,
`echo "…; git push …"`) é aceito na direção segura. Cada furo novo dentro do
escopo declarado é bug; fora dele, não é.

## Válvulas

| válvula                     | libera                             | nunca libera          |
| --------------------------- | ---------------------------------- | --------------------- |
| `LOHRA_PERMITE_PUSH_MAIN=1` | push em `main` (camadas 1 e 2)     | force-push            |
| `LOHRA_MERGE_LIVRE=1`       | `gh pr merge` sem checks/label (1) | `gh pr merge --admin` |

Valem no ambiente do hook ou escritas no próprio comando
(`LOHRA_PERMITE_PUSH_MAIN=1 git push …`). São para bootstrap e operação humana
consciente; um agente não deveria precisar delas.

## Testar por pipe

```sh
printf '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | .claude/hooks/protege-main.sh; echo "exit=$?"
printf '{"tool_name":"Write","tool_input":{"file_path":"%s/docs/reference/x.md"}}' "$PWD" | .claude/hooks/protege-escrita.sh; echo "exit=$?"
printf 'refs/heads/x abc refs/heads/main def\n' | .claude/hooks/git-pre-push origin url; echo "exit=$?"
```

`exit=2` é negação (hooks do Claude Code); `exit=1` é recusa (hook do git). A
bancada automatizada está em `tests/protege-main.test.ts`,
`tests/protege-escrita.test.ts` e `tests/stop-gate.test.ts`
(`npm run prova -- bancada-hooks`).
