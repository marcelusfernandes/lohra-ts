// Issue #241: `runParallel` cacheava o grupo inteiro sob uma única célula e
// só gravava quando TODAS as branches voltavam não-vazias — sucesso parcial
// (N-1 vivas, 1 morta) nunca era persistido por branch, então um resume
// refazia todas de novo, não só a morta. `replayOrCollectBranch`
// (engine-utils.ts) dá a cada branch a sua própria célula (`hash_i`,
// indexada por node id + índice + prompt + routing); uma branch com célula
// já cacheada reusa sem spawnar, e a célula do grupo continua agregando —
// grava só quando todas não-vazias, como antes.
//
// O teste novo em workflow-hardening.test.ts estende "refuses output and
// cost atomically and retries a partial fanout" para 3 branches (1 morta) e
// 3 execuções sobre a MESMA MemoryWorkflowCache: a primeira spawna as 3
// (1 falha), a segunda (resume) respawna só a morta, a terceira acerta a
// célula do grupo (já completa) e não spawna nada — pinando `nodeCosts` e
// `cache.totalSplit` em cada passo, não só a contagem de requests.
// workflow-service-durability.test.ts não ganhou teste novo (também no teto
// de linhas do contrato `arquivo-grande`); continua listado aqui como
// regressão do resto do contrato de durabilidade, que este fix não pode
// quebrar — o caminho durável usa SqliteWorkflowCache internamente
// (service.ts) e os testes de #240/#239 já exercitam resume real sobre ele.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-hardening.test.ts", "tests/workflow-service-durability.test.ts"],
} satisfies Declaracao;
