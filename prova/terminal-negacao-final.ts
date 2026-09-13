// Issue #577 (épico #575): a description de `terminal` prometia aprovação
// humana que nenhum modo implementa, e o envelope de recusa atribuía a
// negação a um "usuário" que nunca participou. A description passa a dizer
// que a recusa é automática e final; o envelope nomeia a política e o
// padrão perigoso e carrega `refusal: "final"`. `createChildDispatch` usa o
// mesmo vocabulário para a recusa de padrão perigoso (prefixo de
// subagente); a guarda de `command` não-string ganha mensagem própria de
// erro de argumento, sem inventar uma política que não roda nesse caminho.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/tools-local.test.ts",
    "tests/tools-security-lifecycle.test.ts",
    "tests/tools-terminal-description.test.ts",
  ],
} satisfies Declaracao;
