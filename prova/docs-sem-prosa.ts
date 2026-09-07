// Issue #164: tests/t22-docs.test.ts deixa de fixar prosa do README byte a
// byte (quebra de linha embutida) e passa a comparar com a fonte
// (COMMAND_SUMMARY, WORKFLOW_SPEC, package.json).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/t22-docs.test.ts"],
} satisfies Declaracao;
