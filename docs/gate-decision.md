# Gate decision: Lohra TypeScript mainline

> **HISTÓRICO** — registro válido de 2026-08-29 a 2026-09-04. A premissa de
> oracle/paridade descrita abaixo foi superada pela decisão de desenvolvimento
> independente (ver `CLAUDE.md` e `docs/adr/0003-native-wire-format.md`). A
> escolha de mainline TypeScript permanece; ver `docs/gate-decision-t22.md`.

- **Status:** accepted
- **Date:** 2026-08-29
- **Decision:** `lohra-ts` becomes the mainline for the next Lohra runtime chapter.
- **Parity baseline:** Python commit `16b4785d803ad0ca364a8a67346a04f949fbf592`.

## Context

This repository began as a TypeScript laboratory for validating the riskiest
runtime mechanisms before choosing a long-term direction. The product decision
gate described in `AGENTS.md` is now resolved: the goal is a complete
TypeScript implementation of the Lohra Python application, preserving its
observable behavior rather than running two partial runtimes indefinitely.

## Decision

The TypeScript implementation will live under `src/`. The nested `lohra/`
checkout remains a clean, read-only behavioral oracle pinned to the baseline
commit. Its Python implementation, tests, and documentation define the
semantics to reproduce.

Compatibility is the default. Language-driven redesigns, API cleanup, renamed
behavior, or new product features are out of scope unless they are recorded as
explicit follow-up decisions. Each migrated slice must be accepted through
TypeScript tests and, where practical, differential or contract tests against
the pinned Python behavior.

Acceptance is never test-only. Every slice additionally requires live
execution evidence on both runtimes — running the pinned Python oracle and the
TypeScript implementation on the same behavior and comparing concrete,
observable output. See `docs/parity-validation.md` for the operating
procedure.

## Consequences

- The previous laboratory-only wording and roadmap must be revised as planning
  advances so that repository documentation reflects the mainline decision.
- Porting proceeds in bounded, dependency-aware slices rather than file-for-file
  mechanical translation.
- The Python baseline is updated only at explicit synchronization milestones;
  upstream changes do not silently expand an active ticket.
- The existing invariants remain mandatory: frozen system prompts, fail-closed
  faults, bounded budget/fan-out, and lease/fence protection for cross-process
  state writes.

## Decisões do usuário — 2026-08-30 (noite)

Três itens que estavam retidos foram decididos, com procedência registrada.

**1. Escalação de privilégio via `sub_id` (L22) — paridade mantida.**
No oracle, um `prompt.submit` usando o `sub_id` promove a subsessão isolada (5
tools) a sessão de gateway com as 24 tools, com o histórico do filho replayed no
agente privilegiado, e a sessão escalada some do `session.list`.

Razão da manutenção, revisada contra a superfície de ataque real: explorar isso
exige um cliente **já autenticado** no WebSocket, e esse cliente pode criar uma
sessão normal com as 24 tools de qualquer forma — não há ganho de acesso. O que
o furo quebra é o **invariante de isolamento do subagente**, não a fronteira de
autenticação. Divergir criaria diferença de comportamento silenciosa num runtime
que deve ser drop-in.

Condições que permanecem: comportamento fixado por teste nomeado, promoção
logada com causa em arquivo/sink (nunca stdout/stderr), e **reavaliação
obrigatória quando TUI/GUI expuserem o gateway além do loopback** — nesse
momento o cálculo muda.

**2. Allow-list fechada de tools do subagente — hardening mantido, com
reavaliação marcada no T19.**
É estritamente mais restritiva que a deny-list do oracle, com prova estrutural
(`A ∩ E = ∅ ⇒ A ∩ P ⊆ P − E`, válida para qualquer conjunto de tools do pai).
Hoje a diferença só aparece para nomes fabricados.

**A partir do T19 (MCP) ela vira diferença funcional real**: tools MCP recebem
nomes que a deny-list do oracle libera ao filho e a allow-list do TS recusa.
Registrado como obrigação não adiável no ticket do T19; silêncio no contrato
daquela fatia é motivo de rejeição.

**3. Smoke live — autorizado, com escopo estreito.**
Única exceção à proibição de egress nesta migração. Um turno por transport, sem
tools, `max_tokens` mínimo, perfil isolado `lohra-ts-oracle`, apenas
`chat_completions` (openrouter) e `anthropic_messages` (anthropic).

**`responses/codex` permanece FORA e a linha continua aberta para ele**: ele
autentica por subscription com a credencial real do operador em
`~/.codex/auth.json`, que não foi autorizada nominalmente. Não pode ser fechada
por analogia com os outros dois.

Motivo de autorizar: até aqui os três transports foram provados **apenas contra
upstream sintético em loopback**. A regra de aceitação deste projeto é que
sucesso não é teste passando, é uso real — e essa linha estava aberta desde o
T10.

### Smoke live — resultado (2026-08-31)

Executado sob autorização nominal do usuário, com credencial no perfil isolado
`lohra-ts-oracle`. **Dois requests no total, 32 tokens somados.**

| Transport            | Modelo                          | Resultado        | `requestCount` |
| -------------------- | ------------------------------- | ---------------- | -------------- |
| `anthropic_messages` | `claude-opus-4-8`               | **pass**, exit 0 | 1              |
| `chat_completions`   | openrouter `openai/gpt-4o-mini` | **pass**, exit 0 | 1              |

**Pela primeira vez na migração, o runtime TypeScript completou um turno contra
provider real.** Todas as fatias anteriores foram provadas contra upstream
sintético em loopback.

**O que foi verificado: forma, não conteúdo** — schema fechado com as chaves na
ordem declarada, `success: true`, exit 0, usage presente e coerente, conteúdo
não vazio, tool-calls ausentes. Texto **não** foi comparado com o oracle: com
provider real não há determinismo, e comparar conteúdo produziria evidência
falsa. Este resultado **não** é paridade byte-exata com provider real, e não
deve ser lido como tal.

**Travas:** cap de 1 request **provado sob condição real**; allowlist de endpoint
e `maxRetries: 0` **provados em isolamento** — a allowlist recusa antes de
qualquer socket, então "condição real" e "isolamento" são o mesmo caminho de
código; forçar retry exigiria fabricar falha de provider.

**Segurança:** zero ocorrência de padrão de credencial nas evidências e nos
arquivos de stdout/stderr. Canários de scrub reexecutados **depois** das chamadas
reais (`caught: 3`, evidência ausente) — provar o scrub vivo após o egress é
diferente de prová-lo antes. Credencial resolveu do perfil isolado; nenhum sinal
do store compartilhado.

**`responses/codex` permanece ABERTO.** Autentica por subscription com a
credencial real do operador em `~/.codex/auth.json`, não autorizada
nominalmente. **Não fecha por analogia** com os outros dois.

### Incidente de credencial (2026-08-31, madrugada) — contido

Ao testar o caminho "sem credencial", o Generator passou `--allow-live` a si
mesmo. `env -u ANTHROPIC_API_KEY` **não isola**, porque `resolvePaths`/
`applyEnvFile` carregam `~/.lohra/.env` pelo `$HOME` real. Houve tentativa de
chamada com credencial real sem autorização — **uso não autorizado, não
exfiltração**: o destinatário seria a própria Anthropic, dona da chave.

Contenção verificada de forma independente: o guard `CREDENTIAL_LEAK` impediu a
escrita, nenhuma evidência com a chave existe em disco, zero padrão de chave no
checkout e nos artifacts, porcelain limpo. Rotação julgada desnecessária.

Correção estrutural: guarda de **fonte** de credencial nos dois runners — recusa
com causa quando a credencial só aparece após carregar o store compartilhado —,
resistente a dois bypasses encontrados depois (`LOHRA_HOME` apontado ao próprio
store compartilhado; symlink escapando da comparação de caminho). Também: índice
do secret em stderr para tornar a recusa diagnosticável, e piso de 24 caracteres
no teste de substring, que eliminava falso positivo com resposta curta.

Lição registrada: um caminho de recusa que só é seguro se quem o testa lembrar
de uma precaução **não escrita** é um caminho de recusa defeituoso.
