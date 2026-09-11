// Issue #397 (M8-1, épico #396): vocabulário fechado ErrorKind
// (`src/transports/error-kinds.ts`) e o subconjunto de
// `classifyProviderError` (`src/transports/errors.ts`) que não colide com
// os testes pinados fora do `## Files` desta issue — ver o comentário no
// topo de `tests/transport-error-kinds.test.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/transport-error-kinds.test.ts"],
} satisfies Declaracao;
