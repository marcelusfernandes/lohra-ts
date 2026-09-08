// Issue #197: passo 11 de orquestracao.md, agente qa e Convenções citam
// `mutations:all` e `mutations.yml`, nunca o coringa `mutations:*`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/t22-docs.test.ts"],
} satisfies Declaracao;
