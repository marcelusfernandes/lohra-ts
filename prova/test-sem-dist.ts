// Issue #2: `npm test` não pode depender de `npm run build` — o teste de
// paridade `responses-profile.test.ts` importava `dist/` por tabela
// (via `scripts/parity/provider-transports/responses-profile.mjs`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/parity/responses-profile.test.ts"],
} satisfies Declaracao;
