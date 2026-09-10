// Issue #241: `runParallel` cacheava o grupo inteiro sob uma única célula e
// só gravava quando TODAS as branches voltavam não-vazias — sucesso parcial
// (N-1 vivas, 1 morta) nunca era persistido por branch, então um resume
// refazia todas de novo, não só a morta. `replayOrCollectBranch`
// (engine-utils.ts) dá a cada branch a sua própria célula (`hash_i`,
// indexada por node id + índice + prompt + routing); uma branch com célula
// já cacheada reusa sem spawnar, e a célula do grupo continua agregando —
// grava só quando todas não-vazias, como antes.
//
// O teste em workflow-hardening.test.ts estende "refuses output and cost
// atomically and retries a partial fanout" para 3 branches (1 morta) e 3
// execuções sobre a MESMA MemoryWorkflowCache: a primeira spawna as 3 (1
// falha), a segunda (resume) respawna só a morta, a terceira acerta a
// célula do grupo (já completa) e não spawna nada — pinando `nodeCosts` e
// `cache.totalSplit` em cada passo, não só a contagem de requests.
//
// PR #305 rodada 2: a célula do grupo também gravava o total já gravado
// pelas células por branch — todo token em `workflow_node_cost` dobrava, e
// `WorkflowService.seedSpend` (soma as linhas de custo) podia semear um
// resume com até 2x o gasto real. `recordGroupReplayCost` corrige: a
// célula do grupo grava custo NULL; num HIT do grupo, a função re-soma o
// custo real de cada célula por branch (leituras baratas, nunca spawn).
// workflow-hardening.test.ts pina em `cache.totalSplit` (3, não 6) depois
// do resume e do replay do grupo. tests/workflow-parallel-cells.test.ts é
// novo — tests/workflow-hardening.test.ts e
// tests/workflow-service-durability.test.ts já estavam no teto de linhas
// do contrato `arquivo-grande` (confirmado contra origin/main, sem espaço
// para um teste de serviço durável) — pina o caminho SqliteWorkflowCache
// real via WorkflowService: 3 branches (1 morta), resume, e um resume
// orçado entre o gasto real (15) e o dobro do bug (30) é aceito, não
// recusado como "já gastou" (verificado revertendo o fix localmente: sem
// ele esse teste falha com "already spent 30 tokens").
// workflow-service-durability.test.ts continua listado aqui como
// regressão do resto do contrato de durabilidade que este fix não pode
// quebrar (os testes de #240/#239 já exercitam resume real sobre
// SqliteWorkflowCache).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-hardening.test.ts",
    "tests/workflow-service-durability.test.ts",
    "tests/workflow-parallel-cells.test.ts",
  ],
} satisfies Declaracao;
