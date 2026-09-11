// Issue #397 (M8-1, épico #396): vocabulário fechado ErrorKind
// (`src/transports/error-kinds.ts`) e o mapeamento completo de
// `classifyProviderError` (`src/transports/errors.ts`): quota inalterado;
// 401/403 -> auth_failed; 404 com indício de modelo -> model_not_found;
// código de rede ou 5xx -> route_fault; qualquer outro ProviderCallFailed
// -> unknown (nunca null); erro que não é de provedor -> null.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/transport-error-kinds.test.ts"],
} satisfies Declaracao;
