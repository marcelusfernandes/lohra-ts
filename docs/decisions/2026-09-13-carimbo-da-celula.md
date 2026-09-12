# Carimbo da célula: `identity_version` marca, nunca invalida

- **Data:** 2026-09-13
- **Origem:** issue #461 (M11-S3, épico #458 "Rotas, cache e artefatos");
  decisão 3 do mapa do épico (comentário do orquestrador na issue #458,
  2026-09-12).

## Contexto

A milestone 11 pedia, no seu próprio enunciado, uma "chave de célula
versionada" para a prévia de cache — uma forma de uma célula durável saber
se a identidade que a gerou (rota, prompt, schema, a própria mecânica de
hash) ainda é a mesma hoje. O mapa do épico #458 registrou três alternativas
para essa decisão antes de decompor a S3:

1. **Carimbo**: gravar `identity_version` AO LADO da célula; um replay cuja
   versão não bate marca `version_state: "stale"`, mas continua replayando
   normalmente.
2. **Na chave**: um bump de versão entraria no `content_hash` — invalidaria
   TODO o cache durável de uma vez, à revelia da rota/nó específico que
   mudou.
3. **Sair**: não versionar nada nesta rodada.

## Decisão

**Carimbo, não chave.** `CELL_IDENTITY_VERSION` (`src/workflow/cache.ts:38`,
hoje o literal `"1"`) é gravado numa coluna `identity_version` de
`workflow_node_cache` (`TEXT`, via `addedColumns`,
`src/state/schema.ts:149`) na MESMA transação que grava a célula
(`putCacheCellWithCost`, `src/state/workflow-repository.ts:256-319`) —
nunca dentro do `content_hash` que decide se uma célula é a mesma
(`contentHash`, `cache.ts`).

- **O que faz o carimbo subir**: só uma mudança nas PARTES que uma célula
  hasheia (`runAgent`/`runParallel`/... em `engine.ts`,
  `loopCellParts`/`replayOrCollectBranch`/... em `engine-utils.ts`) — nunca
  uma migração de schema, nunca um release de rotina. O bump vive na MESMA
  PR que essa mudança; `tests/workflow-cache-stamp.test.ts` prende a
  constante e a fórmula do hash raiz num único `it`, para que os dois nunca
  driftem sem um teste vermelho.
- **Marca, nunca invalida**: um replay cujo carimbo é `stale` (presente mas
  DIFERENTE de `CELL_IDENTITY_VERSION`) acontece EXATAMENTE como um replay
  `current` — o cache nunca recusa nem descarta a célula por causa da
  versão. A única diferença é a classificação que chega ao operador via
  `cache.replayed {version_state}` (`docs/workflow-audit.md`): `current`
  (bate), `stale` (não bate — a identidade da célula mudou desde que foi
  escrita, tipicamente um pivô de rota) ou `unstamped` (`NULL` — célula
  gravada por um banco anterior a esta issue, nunca teve carimbo).
  `MemoryWorkflowCache` (`cache.ts`) nunca produz `unstamped` — toda célula
  seguida na memória do processo já nasce carimbada — só `current`/`stale`.
- **"Chave versionada" (o enunciado do milestone) fica registrada como
  alternativa rejeitada**: um bump na chave invalidaria TODO o cache
  durável de um deploy, sem distinguir o nó/rota que de fato mudou — o
  oposto do padrão "custo, não corrupção" que este runtime já segue
  (`docs/decisions/2026-09-10-cache-escopo-irmaos.md`, seção "Consequência
  para bancos existentes": um miss por escopo/chave que mudou é sempre
  RE-EXECUÇÃO, nunca dado perdido) e do precedente do lohra Python #75
  ("marcar, nunca invalidar"), citados pelo comentário da decisão do
  épico #458.
- **O que `stale` significa para quem lê `workflow_status`/`workflow_audit`**:
  a célula foi reaproveitada normalmente — o token e o tempo foram
  poupados — mas a identidade que a gerou não é mais a atual (um pivô de
  rota é o gatilho típico). Não é um aviso de dado errado nem um pedido de
  ação; é informação de proveniência, do mesmo jeito que `unstamped` avisa
  "este banco é mais velho que a coluna", nunca "este dado é suspeito".

## O que esta decisão NÃO faz

- Não invalida nenhuma célula durável já gravada — um banco de antes desta
  issue simplesmente lê `unstamped` na primeira vez.
- Não versiona nada além da MECÂNICA de hash — um pivô de rota, uma edição
  de prompt/schema feita pelo autor da spec, ou qualquer outra mudança de
  CONTEÚDO da célula já muda o `content_hash` em si (miss normal,
  `reason: identity_changed`) e nunca depende do carimbo para ser
  detectada; o carimbo cobre só a mudança na FÓRMULA que o runtime usa
  para computar esse hash.

## Evidência

- `tests/workflow-cache-stamp.test.ts`: `CELL_IDENTITY_VERSION` e a fórmula
  do hash raiz pinados num único `it` (drift vira um teste vermelho, não
  dois números divergentes em silêncio); os três valores de
  `version_state` (`current`/`unstamped`/`stale`) e os dois de `reason`
  (`never_completed`/`identity_changed`); o `node_id` da célula ESCOPADO —
  não o id cru (describe `workflow_node_cache.node_id — dono ESCOPADO, não
o id cru (#461, #475)`) — inclusive a limitação declarada de uma linha
  pré-#461 sob o id cru não bater numa busca escopada (lê
  `never_completed`); `cache.missed{reason}` no ledger de auditoria após um
  pivô de rota que recomputa um nó já cacheado.
- `tests/state-workflow-repository.test.ts`: o carimbo grava na MESMA
  transação da célula; sem `identityVersion`, a coluna fica `NULL` (a
  classificação `unstamped` de `SqliteWorkflowCache`, não uma coluna que
  deixa de ser escrita).
- `tests/workflow-audit-cache.test.ts`: um recorte menor do mesmo
  vocabulário no decorador de auditoria — `cache.missed {reason:
"never_completed"}` e `cache.replayed {version_state: "current"}` num
  round-trip real de `WorkflowService`.
- `tests/workflow-audit-allow-list.test.ts`: oráculo de `version_state` na
  allow-list de `SAFE_STRING_VALUES` (`audit-model.ts`) — preserva os três
  valores do vocabulário, redige qualquer um fora dele.
