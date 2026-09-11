// Issue #412 (M8-10, épico #396): veredito da PR #409 apontou três lacunas
// da guarda "`quota_exhausted` nunca entra em `fault_kinds`" — (1) nenhum
// teste exercitava `engine-utils.ts:490` (a única guarda da promessa feita
// em `builtin-definitions.ts`); (2) a releitura de `prior_fault_kinds`
// (`service.ts:157`) usava `.map(String)` sem `.filter(isErrorKind)`, então
// uma linha de `pause_payload_json` adulterada injetava string livre em
// `fault_kinds_total`; (3) o comentário de `accounting.ts:66-69` atribuía a
// exclusão de quota ao lugar errado. `tests/workflow-fault-kinds.test.ts`
// prova as três: dois casos de guarda (folha só-quota, folha quota+auth) e
// um caso de releitura filtrada (linha com `["auth_failed", "garbage"]` →
// `fault_kinds_total == ["auth_failed"]`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-fault-kinds.test.ts"],
} satisfies Declaracao;
