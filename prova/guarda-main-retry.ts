// Issue #209: guarda-main.yml tenta mais de uma vez (e confirma o merge
// commit pela PR) antes de abrir issue `human` por push direto em main.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-guarda-main.test.ts"],
} satisfies Declaracao;
