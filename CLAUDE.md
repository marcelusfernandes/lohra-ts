
# lohra-ts — laboratório TS

Runtime TypeScript de exploração. **Não é o runtime principal** — o Lohra em
Python (`github.com/marcelusfernandes/lohra`, PyPI `lohra`) segue como fonte de
verdade das semânticas. Toda decisão semântica começa lendo o Python e
`docs/reference/`, nunca se inventa aqui.

**IMPORTANTE:** Não serão feitas implementações no lohra/ em python, ele é somente referência para a implementação do typescript


## Meta de produto

Núcleo headless orientado a eventos → **TUI** (Ink) → **GUI Electron**
(Mac + Windows). TUI e GUI são renderers do mesmo protocolo de eventos.

## Hipóteses (ordem de risco)

1. Durabilidade cross-process (leases, fencing, WAL) via `better-sqlite3`.
2. Protocolo de eventos único p/ TUI+GUI (derivado de `workflow/events.py` +
   liveview + `lohra chat --json` + eventos WS do gateway Python).
3. Terminal via `node-pty`.
4. Semânticas do harness: budget, cache por célula, resume, checkpoint.

## Gate de decisão (obrigatório antes de escalar escopo)

Hipóteses validadas → escolher explicitamente: (a) lohra-ts mainline do novo
capítulo, (b) voltar ao Python com backports, (c) dual-track com fronteiras.
Escrever a decisão em `docs/gate-decision.md` quando ocorrer.

## Convenções

- TDD: teste primeiro, cobertura alta, mesma disciplina do repo Python.
- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Arquivos pequenos (200–400 linhas típico, 800 max). Conventional commits.
- Fail-closed: exceção nunca é engolida silenciosamente (log ou propaga).
- Imutabilidade: nunca mutar estruturas compartilhadas; retornar cópias.
- Sem segredos no repo.
- `docs/reference/` é cópia congelada da documentação do Python — não editar.

## Invariantes a respeitar no port (do Python)

1. System prompt construído uma vez por sessão e congelado; memória/skills
   mudam disco, nunca o prompt vivo.
2. Falha nunca é silenciosa — fault com causa em todo caminho.
3. Budget/fan-out nunca unbounded.
4. Escrita de estado cross-process sempre sob lease/fence.
\