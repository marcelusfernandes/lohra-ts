// Fixture só para `tests/prova-declaracoes.test.ts`: declara um `unit` que
// EXISTE em disco (`quebrada.ts`, este mesmo diretório) mas não termina em
// `.test.ts` — cobre o segundo `if` de `verificarDeclaracao` (issue #214,
// revisão pós-PR), que a fixture `quebrada.ts` sozinha não exercitava
// (falha antes, na checagem de existência). Nunca é uma prova real.
import type { Declaracao } from "../../../scripts/prova/tipos.js";

export default {
  unit: ["tests/fixtures/prova-declaracoes/quebrada.ts"],
} satisfies Declaracao;
