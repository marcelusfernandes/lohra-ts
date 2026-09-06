# Proveniência

O invariante: todo SHA marcado `approved` em [`docs/provenance.json`](provenance.json)
é ancestral do `HEAD` de `main`. É o que garante que trabalho aprovado — pela
review humana nos tickets T00–T21, pelo agente `revisor` desde a issue #9 —
nunca é perdido, reescrito ou substituído silenciosamente por um force-push,
um rebase de `main` ou um squash-merge. `docs/closeout.md:3-4` registra o
mesmo invariante em prosa, para os SHAs T00–T22; este documento descreve o
formato, o script e as flags que o tornam um gate de CI em vez de uma
promessa.

## Formato de `docs/provenance.json`

Schema validado por `parseProvenanceDocument`/`validateEntry` em
`scripts/provenance/extract.ts`. Um objeto com `entries`, array de:

| campo    | tipo                      | regra                                                           |
| -------- | ------------------------- | --------------------------------------------------------------- |
| `ticket` | string                    | casa `T\d{2}` (`T00`–`T22` hoje)                                |
| `sha`    | string                    | não vazio; se `status` é `approved`, precisa ser 40 hex         |
| `result` | string                    | não vazio — texto livre (ex.: `"integrado; Evaluator 100/100"`) |
| `status` | `"approved" \| "pending"` | única distinção que o verificador consulta                      |

Qualquer desvio lança `PROVENANCE_SCHEMA:<path>:<motivo>` com o índice da
entrada e o valor recebido — nunca falha em silêncio nem tenta adivinhar.
O caminho default é `docs/provenance.json` na raiz do repositório
(`defaultProvenancePath` em `extract.ts`).

### `pending`

Duas formas, tratadas de jeitos diferentes por `evaluateProvenance` em
`scripts/provenance/check-ancestry.ts`:

- **Placeholder** (`sha` não é 40 hex, ex.: `EVIDENCE_BOUND_FINAL_SHA` do
  T22): nunca é checado contra o git nem reprova nada — conta em `skipped`,
  puramente informativo.
- **SHA real** (uma decisão ainda não fechada, mas já com commit de verdade):
  reprova com a causa `PENDING`, a menos que `--pending-ok` seja passado —
  nesse caso é tolerado (nem checado contra o git, nem conta como falha;
  entra em `tolerated` no `--json`). Essa distinção é o que permite ao mesmo
  comando reprovar em push para `main` e tolerar em PR (issue #160).

### Guarda `PROVENANCE_EMPTY`

`validateDocument` em `check-ancestry.ts` exige pelo menos uma entrada
`approved`. Um `docs/provenance.json` só com `pending` (ou vazio) sai `2` com
essa causa — nunca um `0/0` silencioso que passaria como "ok" sem checar SHA
nenhum contra o git.

## O script e as flags

`scripts/provenance/check-ancestry.ts` (`npm run provenance:check`). Cada
entrada `approved` é verificada com dois comandos `git`: `cat-file -e
<sha>^{commit}` (o SHA existe neste repositório?) e, se existir,
`merge-base --is-ancestor <sha> HEAD` (é ancestral do `HEAD`?). Um clone raso
(`git rev-parse --is-shallow-repository`) pode fazer os dois comandos
falharem sem que a proveniência esteja quebrada de verdade — por isso, com o
repositório raso, a causa vira `SHALLOW_CLONE` em vez de
`SHA_UNKNOWN`/`NOT_ANCESTOR`. É por isso que o job do CI roda com
`fetch-depth: 0`.

Causas nomeadas (`FailureCause`): `SHA_UNKNOWN`, `NOT_ANCESTOR`,
`SHALLOW_CLONE`, `PENDING`.

Flags:

```
npm run provenance:check                        -- texto, saída preservada
npm run provenance:check -- --json               -- {checked, ok, failures, skipped, tolerated}
npm run provenance:check -- --pending-ok         -- tolera "pending" com SHA real
npm run provenance:check -- --provenance <path>  -- outro arquivo (default: docs/provenance.json);
                                                     os comandos git rodam com cwd = process.cwd()
```

Exit codes:

- `0` — ok (nenhuma falha, respeitando `--pending-ok`)
- `1` — pelo menos uma falha (`SHA_UNKNOWN` | `NOT_ANCESTOR` | `SHALLOW_CLONE` | `PENDING`)
- `2` — guarda: `docs/provenance.json` (ou `--provenance`) ilegível, com schema
  inválido, ou sem nenhuma entrada `approved` (`PROVENANCE_EMPTY`)

## Como o CI usa

O job `provenance` de `.github/workflows/ci.yml` roda em todo push e PR, com
`fetch-depth: 0`. A partir da issue #160: em push para `main` o comando roda
estrito (sem `--pending-ok` — um `pending` com SHA real reprova o push); em
`pull_request` roda com `--pending-ok` (uma entrada `pending` recém-criada na
própria PR não bloqueia a PR, só o push final quando ela vira `approved`).
Em ambos os casos roda com `--json`, e a saída vai para o step summary do
job (bloco ` ```json `) sem engolir o exit code — o job falha ou passa
pelo `exit $status` do comando, não pela presença do summary.

## Por que `merge` é o único método permitido

O ruleset `protege-main` (id `22348036`, `scripts/github/ruleset.sh:33`) fixa
`"allowed_merge_methods": ["merge"]` para `refs/heads/main` — o GitHub recusa
squash e rebase-merge nessa branch, não importa o que o botão da PR ofereça.
É a contraparte do invariante deste documento: o job `provenance` verifica
ancestralidade assumindo que o histórico de `main` nunca foi reescrito; um
squash cria um commit novo cujo pai não é o head aprovado, e um rebase move
o SHA aprovado para fora da árvore — os dois quebrariam a garantia sem que
nada no diff da PR acusasse. `docs/adr/0004-trabalho-autonomo.md:66` registra
a mesma decisão em prosa.

O AC 9 original da issue #9 — "Squash merge e rebase merge desabilitados nas
configurações do repositório GitHub (`gh repo view --json
squashMergeAllowed,rebaseMergeAllowed` retorna `false` para ambos)" — está
obsoleto na forma: hoje `squashMergeAllowed` e `rebaseMergeAllowed` continuam
`true` nas configurações do repositório (o botão da PR ainda oferece as
opções), e o invariante vale mesmo assim, porque é o ruleset — não o toggle
de repositório — que recusa o merge na branch `main`.

## Como adicionar uma entrada

Editar as duas fontes na mesma PR — `docs/provenance.json` (o objeto
`{ ticket, sha, result, status }`) **e** a tabela de `docs/closeout.md`: o
teste bidirecional (`tests/provenance-extract.test.ts`, via
`extractTableRows`/`readProvenance` de `scripts/provenance/extract.ts`)
reprova se as duas fontes divergirem — ticket, SHA ou resultado presentes
numa e ausentes ou diferentes na outra.

## Referências

- `docs/closeout.md` — a tabela em prosa, fonte espelhada
- `docs/adr/0004-trabalho-autonomo.md` — a decisão de merge commit como único
  método de integração em `main`
- `scripts/github/ruleset.sh` — o ruleset que aplica `allowed_merge_methods`
- `scripts/provenance/extract.ts`, `scripts/provenance/check-ancestry.ts` —
  schema, extração e verificação
