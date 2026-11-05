// Issue #978 (épico #976 §6): a porta `ChildRuntime.callTool` — chamar uma
// tool de leitura SEM modelo pelo mesmo sandbox, taint, fence e auditoria de
// um leaf. tests/workflow-call-port.test.ts prova a regra
// (`call-tools.ts`: allow-list `read_file`/`web_fetch`, deadline com teto de
// 120 s, classificação ok/error/denied/timeout) e a segurança (chamada
// negada nunca chega ao dispatch base; stretch aposentado é negado com "no
// longer current"; web_fetch contamina; run tainted fecha fs e egress);
// tests/workflow-call-port-audit.test.ts prova o par `tool.*` com `sub_id`
// sintético e sem `leaf.*`. tests/workflow-sandbox.test.ts e
// tests/workflow-audit-tool.test.ts seguram a regressão: o sandbox e a
// auditoria do leaf continuam byte a byte como eram.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-call-port.test.ts",
    "tests/workflow-call-port-audit.test.ts",
    "tests/workflow-sandbox.test.ts",
    "tests/workflow-audit-tool.test.ts",
  ],
} satisfies Declaracao;
