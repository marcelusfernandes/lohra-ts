// Issue #157: docs/mutation-testing.md documenta as mecânicas, o formato de
// catálogo e a contagem real por fatia do harness de mutação, com links de
// README/AGENTS.md/CLAUDE.md — `tests/t22-docs.test.ts` prova que os links
// relativos do README continuam resolvendo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/t22-docs.test.ts"],
} satisfies Declaracao;
