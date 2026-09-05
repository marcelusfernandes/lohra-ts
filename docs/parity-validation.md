# Validação de paridade por uso real

> **HISTÓRICO** — procedimento válido de 2026-08-29 a 2026-09-04. Superado
> pela decisão de desenvolvimento independente (ver `CLAUDE.md` e
> `docs/adr/0003-native-wire-format.md`). Mantido como registro de como as
> fixtures de paridade foram capturadas.

Testes verdes são condição necessária, **nunca suficiente**, para aceitar uma
fatia migrada. Toda entrega precisa de evidência de execução real nos dois
runtimes, comparada concretamente.

## O oracle Python executável

O checkout `lohra/` (pinado em `16b4785d…`, `lohra 0.0.11`) está instalado num
venv dedicado na raiz deste repo:

```bash
# já criado; recriar se necessário:
~/.pyenv/versions/3.12.10/bin/python -m venv .oracle-venv
.oracle-venv/bin/pip install -e "lohra/backend[dev]"
.oracle-venv/bin/lohra --version   # deve imprimir: lohra 0.0.11
```

Atenção: `~/.pyenv/shims/lohra` resolve para outra instalação. **Sempre**
invocar via `.oracle-venv/bin/lohra` para falar com o baseline pinado.

## Perfil isolado

Todo estado do oracle (memória, skills, sessões, cron, auth opt-in) vive em
`~/.lohra/profiles/lohra-ts-oracle/`, nunca no home compartilhado:

```bash
.oracle-venv/bin/lohra <comando> --profile lohra-ts-oracle …
```

Nota de sintaxe: `--profile` é flag do subcomando, vem **depois** dele
(`lohra chat --profile …`, não `lohra --profile chat`). Providers com API key
no ambiente (anthropic, openrouter) estão live; ver
`.oracle-venv/bin/lohra models --profile lohra-ts-oracle`.

O modo de operação (envelopes `--json`, verificação de sucesso, sessões,
footguns de custo) está descrito em `lohra/docs/skills/use-lohra/SKILL.md`.

## Procedimento por fatia

1. **Extrair o comportamento observável do Python.** Executar o cenário no
   oracle e capturar tudo que é contrato: stdout (envelope JSON no `--json`),
   exit code, arquivos criados/alterados sob o profile, eventos emitidos.

   ```bash
   .oracle-venv/bin/lohra chat --profile lohra-ts-oracle --json --no-tools "…" \
     > /tmp/oracle-run.json; echo "exit=$?"
   ```

2. **Executar o mesmo cenário no TypeScript** (CLI/entrypoint equivalente em
   `src/`), capturando os mesmos observáveis.

3. **Comparar de fato.** Campos do envelope, formas de erro, exit codes,
   layout de estado em disco. Diferença = defeito, ou exceção justificada e
   registrada por escrito (no ticket e, se durável, no inventário de paridade).

4. **Registrar a evidência no ticket**: comandos executados, saídas (ou paths
   para elas) e o veredito da comparação. Um ticket sem essa evidência não é
   aceito — volta ao implementador.

## Critérios de sucesso de uma execução (herdados da skill)

- exit code `0`;
- envelope com `error: null`;
- o trabalho reportado corresponde ao pedido;
- para tarefas que exigem evidência de projeto: pelo menos um `tool_calls`
  (resposta zero-tool = delegação falhada, não evidência).

## O que cada tipo de fatia deve exercitar ao vivo

| Fatia                | Execução mínima real                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| CLI (chat, envelope) | `lohra chat --json` nos dois runtimes, diff do envelope                   |
| Providers/auth       | `lohra models`, `lohra auth status` e um chat real por provider suportado |
| Estado/SQLite        | inspecionar `state.db`/arquivos sob o profile após uso real               |
| Workflows            | `lohra workflow …` + eventos/progresso durável comparados                 |
| Server/gateway       | subir os dois servers e comparar respostas HTTP/SSE/WS reais              |
| Tools                | turno com tool real (fs/terminal/web) e comparação do resultado           |

## Fonte da regra

Pedido explícito do usuário (2026-08-29): paridade completa de funcionalidades
com a Lohra Python; sucesso não é definido somente por testes, mas por uso
real e fatos concretos — executando a Lohra Python (via skill `use-lohra`) e o
runtime TypeScript lado a lado.
