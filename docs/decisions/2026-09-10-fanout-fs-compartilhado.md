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
próprio dentro do working root — não exibiu essa perda em nenhuma rodada.
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
