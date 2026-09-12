# Fan-out sobre diretório compartilhado

- **Data:** 2026-09-10
- **Origem:** avaliação de 2026-09-09 das waves do lohra Python contra o
  lohra-ts (ADR 0003: capacidade, nunca paridade); issue #248 (sub-issue do
  épico de hardening do harness).

## Contexto

Um `run_workflow` do TS aloca **um working root por run**, fencado pela
acquisition — não um por branch. `WorkflowService.leafToolDispatch`
(`src/workflow/service.ts:580`) resolve o `workingRoot` da stretch atual (ou
`workingRootOf(runId, 0)`, linha 587) e todo leaf desse run, não importa em
qual branch do DAG, recebe o mesmo `dispatch` fs via `sandboxDispatch`
(`src/workflow/sandbox.ts`). `WorkflowService.workingRootFor` (linha 597)
expõe o mesmo root para quem monta o `dispatch` de uma stretch. Ou seja:
folhas irmãs de um `parallel`, de um `pipeline` ou de qualquer outro fan-out
do mesmo run **compartilham o diretório**, por desenho — o isolamento é por
run, não por branch.

O lohra Python mediu esse cenário no experimento #62
(`docs/history/reviews/2026-09-03-exp62-fanout-shared-fs.md` no repo Python,
referência histórica, não oracle — ADR 0003): dois escritores no mesmo
arquivo, no mesmo diretório compartilhado, perdem uma das duas escritas em
24 de 25 rodadas. Um arquivo por folha — cada branch escrevendo um caminho
próprio dentro do working root — é seguro (a origem cita esse desenho como
seguro, sem detalhar contagem de rodadas para ele, só para o de colisão).
Uma terceira opção, ordenar as escritas por recurso dentro do nó (serializar
o fan-out sempre que duas folhas tocam o mesmo caminho), foi cogitada e
descartada: equivale a serializar o fan-out, contra o próprio motivo de
existir um `parallel`/`pipeline` — não será implementada.

## Decisão

O comportamento do TS é o mesmo, e é adotado como contrato, não como bug:

- **Um working root por run**, fencado por acquisition
  (`src/workflow/service.ts:580-598`), não por branch. Continua assim.
- **Duas folhas do mesmo run escrevendo o MESMO arquivo**: a última escrita
  vence, silenciosamente — `write_file` (`writeFileTool`,
  `src/tools/filesystem.ts:52`) é `writeFileSync` simples, sem lock nem
  merge. Nenhuma camada acima (sandbox, motor) detecta ou serializa a
  corrida; é semântica POSIX de overwrite, não uma falha do runtime.
- **Duas folhas escrevendo arquivos diferentes** sob o mesmo root: seguro,
  sem interferência.
- `write_file(mode="append")` atômico fica **fora de escopo** desta issue —
  só entra se uma decisão futura pedir, com issue própria.

### Por que isso não viola os invariantes do runtime

Os invariantes 2 (falha nunca silenciosa) e 4 (escrita cross-process sob
lease/fence) do `CLAUDE.md` não se aplicam aqui, por dois motivos distintos:

- **Invariante 4** é sobre escrita de **estado do runtime** entre
  _processos_ — a fence de `leafToolDispatch`/`workingRootFor` é exatamente
  essa proteção, e ela já existe: cada _run_ tem seu working root sob
  acquisition. O que não está fenced é a escrita de **arquivos de produto**
  entre _branches irmãs do mesmo run_ — não é o mesmo objeto que o
  invariante protege.
- **Invariante 2** é sobre falha do runtime nunca ser engolida. Aqui não há
  falha do runtime: as duas chamadas a `write_file` retornam sucesso, porque
  do ponto de vista do sistema de arquivos as duas _são_ sucesso — a
  segunda simplesmente sobrescreve a primeira. Não há exceção para propagar
  nem causa para anexar; é o comportamento observável de `writeFileSync`
  chamado duas vezes no mesmo caminho, dentro ou fora de um workflow.

## Doutrina para autores de spec

Um arquivo por folha; agregação num nó a jusante (um `agent`, `pipeline` ou
`completeness_check` que lê o que cada folha escreveu e combina). Nunca
desenhar duas folhas do mesmo `parallel`/`pipeline` escrevendo no mesmo
caminho esperando que a última vença por acaso — ela vai vencer, mas qual
delas é indeterminado sob concorrência real. O parágrafo equivalente está na
descrição da tool `run_workflow`
(`src/tools/builtin-definitions.ts`, bullet `parallel`).

## Evidência

- `tests/workflow-sandbox.test.ts`, describe `sandboxDispatch — fan-out
over a shared working root (#248)`: duas branches escrevendo o mesmo
  arquivo (última vence, sem erro em nenhuma das duas chamadas) e duas
  branches escrevendo arquivos diferentes (ambos sobrevivem intactos),
  usando `writeFileTool` real como `base` de `sandboxDispatch`.

## Apêndice (2026-09-13): colisão agora DETECTADA como advisory (#463)

A escrita em si continua exatamente como descrito acima — sem lock, sem
merge, a última vence silenciosamente no sistema de arquivos. O que mudou,
issue #463 (M11-S5, épico #458), é que essa colisão deixou de ser invisível
para quem lê o run: todo `write_file` com `ok: true` vira um registro em
`RunResult.artifacts`, e uma segunda folha distinta escrevendo o MESMO
`path` dispara `"<nodeId>: artifact path written by 2 leaves: <path>"` em
`artifactFaults` — advisory, nunca em `faults`, nunca muda `status`
(decisão 6 do épico #458, `docs/workflow-supervision.md`).

**Limitações conhecidas, achados do veredito da PR #483 (issue #485, ainda
aberta em `state:ready` — nenhuma das cinco resolvida neste registro)**:

1. Um lote `[p, p]` de uma folha B, depois de A já ter escrito `p`, empurra
   o fault DUAS vezes — `otherOwners` (`src/workflow/accounting.ts`) é
   recomputado por registro, não deduplicado por caminho já reportado.
2. `DurableRunView.artifact_faults` é escrito (`src/workflow/service.ts`)
   mas nunca lido de volta — `durableRollup` expõe só `artifacts`, e a
   dobra terminal só faz `unshift` de `artifacts`; a colisão do stretch 1
   some dos `faults` vivos depois de um resume.
3. Colisão ENTRE stretches não é detectada — a checagem só compara contra
   `result.artifacts` da stretch CORRENTE, nunca contra o que uma stretch
   anterior já escreveu.
4. O caminho é comparado como string crua (sem `path.posix.normalize`) —
   `./x` e `x` escapam da detecção mesmo apontando para o mesmo arquivo.
5. Custo O(N²) da checagem de colisão e o payload de `artifacts` sem teto
   por run.

Nenhuma dessas cinco muda `status` nem `faults` hoje — são gaps do próprio
mecanismo advisory, não uma regressão do invariante 2 (a escrita em si
continua sem exceção nem causa a anexar, exatamente como a seção acima já
descrevia). A doutrina — um arquivo por folha, nunca contar com a última
escrita vencer por acaso — continua a mesma.

**Fora do escopo de #485, limitação registrada no próprio código**: um
sub-workflow por `ref` nunca tem seus artefatos checados contra os do run
pai (`foldNestedCounters`, `accounting.ts` — a colisão só é checada dentro
de um `RunResult` plano, antes do fold, e o comentário da própria função
nomeia isso) — nenhuma issue aberta cobre esse gap especificamente.

## Apêndice (2026-09-12): quatro dos cinco gaps fechados (#485)

Issue #485 fechou os itens 1–4 do apêndice acima:

1. **Dedup por caminho**: `RunResult.artifactCollisionPaths` (um `Set` de
   caminhos normalizados já reportados, interno, nunca serializado) faz
   `recordLeafSideChannels` (`accounting.ts`) disparar o advisory **uma vez**
   por caminho colidido, mesmo quando o mesmo lote de uma folha nomeia o
   caminho duas vezes depois de outra folha já tê-lo escrito.
2. **`artifact_faults` durável exposto e dobrado**: `durableRollup`
   (`service.ts`) agora expõe `artifact_faults` (omitido quando vazio, mesmo
   idioma de `artifacts`/`pivots`), e a dobra terminal faz `unshift` de
   `artifactFaults` simetricamente a `artifacts` — a colisão da stretch 1
   sobrevive tanto na leitura ao vivo (`faults`) quanto na fria
   (`durableRollup.artifact_faults`) depois de um resume.
3. **Colisão entre stretches**: `recordCrossStretchArtifactCollisions`
   (`accounting.ts`), chamada uma vez por `pausePayloadOf`
   (`route-override.ts`) a cada escrita terminal, compara os artefatos desta
   stretch contra os acumulados da(s) stretch(es) anterior(es)
   (`priorView.artifacts`) — por CAMINHO apenas, nunca por `sub_id`: o
   limite entre stretches já é prova de que são duas execuções distintas
   (uma reexecução de um nó `agent` simples ainda sem célula cacheada antes
   de um checkpoint, por exemplo, conta como uma folha diferente mesmo
   reescrevendo o MESMO caminho que ela própria escreveu na stretch
   anterior — o doutrina #248 trata isso como advisory-worthy do mesmo jeito
   que duas folhas irmãs no mesmo `parallel`).
4. **Caminho normalizado**: `normalizedArtifactPath` (`accounting.ts`,
   `path.posix.normalize`, nunca `resolve` — o caminho é relativo ao working
   root da folha) é usado em toda comparação de colisão; o `path` gravado em
   `RunArtifact` continua cru, exatamente como a folha o escreveu.

O item 5 (teto `MAX_ARTIFACTS_PER_RUN` e o custo O(N²) da checagem) fica
**fora de escopo** de #485 — não coube sem crescer `service.ts` (orçamento de
crescimento zero) e nenhum cenário de uso hoje aproxima o custo quadrático de
um problema real; entra com issue própria se um caso concreto pedir.
