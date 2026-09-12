// Issue #533 (D4 do épico #529): consulta ao registry e comparação de
// versão para `lohra update` fora de um checkout git, em
// src/commands/update-registry.ts. tests/self-update.test.ts entra junto
// para provar que o caminho git (não tocado por esta issue) continua
// byte-idêntico.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/commands-update-registry.test.ts", "tests/self-update.test.ts"],
} satisfies Declaracao;
