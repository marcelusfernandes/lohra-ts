// Issue #398 (M8-3, épico #396): `SAFE_STRING_VALUES.error_kind`
// (`audit-model.ts`) passa a ser `ERROR_KIND_SET` (`transports/error-kinds.ts`,
// #397) em vez do `new Set(["quota_exhausted"])` provisório — um `error_kind`
// do vocabulário (ex. `auth_failed`) preserva o valor num `leaf.failed`;
// string livre continua marcador `excluded_by_policy`. `reason` não muda.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-allow-list.test.ts"],
} satisfies Declaracao;
