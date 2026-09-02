# lohra-ts

Laboratório TypeScript para validar hipóteses de runtime antes de qualquer port
do [Lohra](https://github.com/marcelusfernandes/lohra) (Python). **Este repo não
substitui o runtime Python** — ele prova mecanismos; as semânticas de verdade
moram no repo Python e em sua documentação (`docs/reference/` aqui).

## Estratégia

Um núcleo headless orientado a eventos, consumido primeiro por uma **TUI**
(Ink) e depois por uma **GUI Electron** (Mac + Windows). O protocolo de eventos
é derivado do prior art do Python: `workflow/events.py`, liveview,
`lohra chat --json` e os eventos WS do gateway.

## Hipóteses a validar (ordem de risco)

1. **Durabilidade cross-process** (leases, fencing, WAL) via `better-sqlite3`
   — prior art: `compression_locks`, `workflow_run_state`, fence #12.
2. **Protocolo de eventos único** para TUI+GUI.
3. **Gestão de terminal** via `node-pty` — prior art: `pty.rs` + `tools/terminal.py`.
4. **Semânticas do harness** (budget, cache por célula, resume, checkpoint).

Chat loop, tools de fs/web e streaming são triviais — não são o propósito do laboratório.

## Gate de decisão

Ao fim das hipóteses, decidir explicitamente: **(a)** lohra-ts vira mainline do
novo capítulo, **(b)** volta ao Python com backports dos aprendizados, ou
**(c)** dual-track com fronteiras claras. Sem essa decisão, dois runtimes pela
metade para sempre.

## Rodar

```bash
npm install
npm run build
npm run typecheck && npm test && npm run lint && npm run format:check
```

O bootstrap da CLI também pode ser executado diretamente; o pacote expõe o
mesmo entrypoint como o binário `lohra`:

```bash
node dist/cli.js --version
node dist/cli.js doctor --json
```

## Harness de paridade

Os cenários versionados ficam em `scripts/parity/scenarios/`. O oracle é
descoberto a partir do worktree principal ou pode ser ligado explicitamente por
`--oracle-workspace`/`LOHRA_ORACLE_WORKSPACE`; esse workspace precisa conter os
siblings read-only `lohra/` e `.oracle-venv/`.

```bash
npm run parity -- --manifest scripts/parity/scenarios/oracle-version.json
npm run parity -- --manifest scripts/parity/scenarios/oracle-no-subcommand.json
npm run parity -- --manifest scripts/parity/scenarios/oracle-workflow-list.json
npm run parity -- --manifest scripts/parity/scenarios/events-jsonl-fixture.json
npm run parity -- --manifest scripts/parity/scenarios/deliberate-divergence.json
```

Evidence canônica é gravada por padrão em `.parity-evidence/<scenario-id>.json`
(gitignored). O CLI usa `0` para match, `1` para divergência e `2` para erro do
harness; portanto o último cenário acima deve retornar `1`.
