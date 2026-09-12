// Declaração de prova da issue #481 (achado do QA pós-merge c959e68f, PR
// #480): prova de migração real para cada entrada de `addedColumns` contra
// um banco criado sem a coluna, e o caso negativo de um erro de
// `ALTER TABLE` que não é "duplicate column name" propagando.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/state-migrations.test.ts"],
} satisfies Declaracao;
