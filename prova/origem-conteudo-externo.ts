// Issue #642 (sub-issue G/D do residual #637): mesma marca `untrusted` para
// erro MCP, symlink resolvido pela mesma régua (`realOrResolved`) nos dois
// sentidos, e raiz da SESSÃO (não do processo) em `skill_view`.
// `tests/context-discovery.test.ts` entra como guarda de `findProjectRoot` —
// nenhuma das três mudanças pode alterar seu comportamento observável.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/mcp-tools.test.ts",
    "tests/tools-local.test.ts",
    "tests/tools-stateful.test.ts",
    "tests/context-discovery.test.ts",
  ],
} satisfies Declaracao;
