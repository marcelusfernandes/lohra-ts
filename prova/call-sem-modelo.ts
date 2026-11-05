// Issue #982 (S6 do épico #976, desenho §6 e §8): o nó `call` — `read_file` ou
// `web_fetch` SEM modelo, pela porta `ChildRuntime.callTool` (#978), com `timeout`
// de até 120 s e `retries` de 0 a 3.
//
// - `tests/workflow-call.test.ts`: o motor — a saída é o envelope parseado, sem leaf
//   nem token; `error`/`timeout` retentam e `denied` nunca; o esgotado é fault com
//   tool, status, tentativas e causa; cada tentativa faz `checkFanout(1)` + `charge()`
//   e o lifetime esgotado é `cap_trips`; run parado não chama; a raiz morta (ou o
//   campo sem valor) de um `${ref}` de `args` dá `upstream null` antes de qualquer
//   chamada; a célula (hash pinado, custo zero) é reaproveitada no resume; runtime
//   sem porta é engine fault; o engine aguarda a porta e segura o processo.
// - `tests/workflow-call-schema.test.ts`: `tool` em `CALL_TOOLS`, `args` objeto de
//   até 16 chaves, `timeout` ≤ 120, `retries` 0 a 3, sem roteamento.
// - `tests/workflow-cache-preview-flow.test.ts`: o ledger (`tool.*` sem `leaf.*`), o
//   resume (a tool não é chamada de novo) e o preview (`would_call` sem somar em
//   `leaves_to_spawn`).
// - `tests/skill-workflow-flow-control.test.ts`: a seção do `call` da skill
//   companheira, com a allow-list e os limites vindos do código.
// - `tests/workflow-flow-seam.test.ts` e `tests/workflow-schema.test.ts`: o registro
//   fechado de tipos e a tabela FLOW_STRATEGIES (+ call).
// - `tests/builtin-definitions-budget.test.ts`: a lista de tipos derivada de
//   `NODE_TYPES` ganha `call` e o catálogo continua no orçamento.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-call.test.ts",
    "tests/workflow-call-schema.test.ts",
    "tests/workflow-cache-preview-flow.test.ts",
    "tests/skill-workflow-flow-control.test.ts",
    "tests/workflow-flow-seam.test.ts",
    "tests/workflow-schema.test.ts",
    "tests/builtin-definitions-budget.test.ts",
  ],
} satisfies Declaracao;
