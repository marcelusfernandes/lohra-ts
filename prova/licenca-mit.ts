// Issue #535: decisão do owner registrada no issue («licença é MIT mesmo») —
// aplica MIT em `LICENSE` e `package.json#license`. `tests/licenca.test.ts`
// pina o texto padrão da MIT License, o copyright do owner e o campo
// `license`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/licenca.test.ts"],
} satisfies Declaracao;
