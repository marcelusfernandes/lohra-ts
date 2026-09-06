// Catálogo de mutantes de `src/self-update/**`, `src/tools/terminal.ts`,
// `src/mcp/manager.ts`, `src/gateway/session-service.ts` e
// `src/commands/session-tools.ts` (issue #153, passo 0f do épico #13). Stub
// temporário — teste vermelho antes da migração dos 8 mutantes de `src/`
// que sobrevivem à triagem do agregador de closeout do diretório histórico
// de paridade.
import type { Mutant } from "./types.js";

export const mutants: readonly Mutant[] = new Proxy([], {
  get(): never {
    throw new Error("not implemented: catálogo de mutação self-update (issue #153)");
  },
});
