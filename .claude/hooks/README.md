# Hooks — proteção da `main` em quatro camadas

Decisão em `docs/adr/0004-trabalho-autonomo.md` (itens 4 e 9). Todos os hooks
parseiam o stdin com **node** (pré-requisito do projeto) — sem `jq`; `protege-*`
são **fail-closed** se node faltar. Portados do Apollo (`tacit-wl/apollo`). A
camada 3 (ruleset) está preparada mas indisponível enquanto o repo for privado
em plano free — hoje valem três camadas, como no Apollo.

| camada | peça                                   | onde vale                         | o que faz                                                                                                                                                                                     |
| ------ | -------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `protege-main.sh` (PreToolUse Bash)    | sessões Claude Code               | nega force-push (sem válvula), push em `main`, apagar `main`, `gh pr merge --admin` (sem válvula), `gh pr merge` sem checks verdes + `review:approved`                                        |
| 1      | `protege-escrita.sh` (PreToolUse Edit) | sessões Claude Code               | nega escrita em `docs/reference/**` e `lohra/**`; resolve symlink que escapa                                                                                                                  |
| 2      | `git-pre-push` (hook git nativo)       | qualquer `git push` desta máquina | recusa push em `main` e push não fast-forward; instalado por `instalar-git-hooks.sh` via `postinstall`                                                                                        |
| 3      | ruleset da `main` (GitHub)             | servidor                          | PR obrigatória, checks required, sem force-push, sem delete — `scripts/github/ruleset.sh`. **Indisponível hoje: repo privado em plano free (403).** Gate humano: tornar público ou GitHub Pro |
| 4      | `guarda-main.yml` (Action)             | servidor, pós-push                | commit em `main` sem PR → issue `human` + job falha                                                                                                                                           |

Outros hooks: `format-file.sh` (PostToolUse Edit|Write: prettier + eslint --fix,
nunca bloqueia) e `tsc-check.sh` (Stop: `tsc --noEmit`, exit 2 até limpar).

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
bancada automatizada dos hooks é o épico #36.
