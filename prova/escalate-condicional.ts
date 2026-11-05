// Issue #981 (S4 do épico #976): o nó `escalate` — pausa o run para revisão
// só quando um predicado (`when`, do S1) vale, com `kind` e `summary`. O run
// fica `paused` com o motivo `escalated`, e a resposta vem por
// `checkpoint_answers`, o mesmo canal do `checkpoint` (`ANSWER_NODE_TYPES`).
//
// - `tests/workflow-escalate.test.ts`: a validação (`when`, `kind`, `summary`,
//   sem roteamento nem `default`) e o motor — `{escalated:false}` sem leaf nem
//   célula, a pausa com `{node_id, kind, summary}`, a resposta que vira saída em
//   cache (hash pinado), o que nunca pergunta de novo, a falha nomeada e o id
//   escopado/colisão num `workflow` aninhado.
// - `tests/workflow-escalate-durable.test.ts`: o caminho durável — status ao vivo
//   e frio com motivo, escalation e hint; resume sem resposta recusado sem lease,
//   sem spawn e sem evento; `lohra workflow list`/`watch`.
// - `tests/workflow-audit-allow-list.test.ts`: o motivo `escalated` do
//   `node.paused` passa pela allow-list do ledger, e os vizinhos continuam redigidos.
// - `tests/workflow-cache-preview-flow.test.ts`: o ledger (`node.paused`, sem
//   leaf nem célula antes da resposta) e o preview (`escalation_pending`,
//   `no_leaves`, `replay`).
// - `tests/workflow-checkpoint-aninhado.test.ts`: o `checkpoint` aninhado segue
//   igual — o escopo e a colisão agora passam por `ANSWER_NODE_TYPES`.
// - `tests/builtin-definitions-budget.test.ts`: as descrições de
//   `checkpoint_answers` e `workflow_status` citam o escalate e o catálogo
//   continua no orçamento.
// - `tests/skill-workflow-flow-control.test.ts`, `tests/workflow-flow-seam.test.ts`
//   e `tests/workflow-schema.test.ts`: a seção da skill, o ponteiro alargado, o
//   registro fechado de tipos e a tabela FLOW_STRATEGIES (+ escalate).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-escalate.test.ts",
    "tests/workflow-escalate-durable.test.ts",
    "tests/workflow-audit-allow-list.test.ts",
    "tests/workflow-cache-preview-flow.test.ts",
    "tests/workflow-checkpoint-aninhado.test.ts",
    "tests/builtin-definitions-budget.test.ts",
    "tests/skill-workflow-flow-control.test.ts",
    "tests/workflow-flow-seam.test.ts",
    "tests/workflow-schema.test.ts",
  ],
} satisfies Declaracao;
