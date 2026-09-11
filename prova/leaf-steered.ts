// Issue #423 (M10-S2): `auditedChildRuntime.steer` (`audit-runtime.ts`) era
// pass-through — nenhum steer deixava rastro no ledger de auditoria.
// `tests/workflow-audit-steered.test.ts` prova: um retry de schema
// (engine.ts:304-308) produz `leaf.steered {source: "engine"}` com o mesmo
// `sub_id` de `leaf.started`, `message_chars > 0` e nunca o texto do steer;
// um steer via o decorador com `source: "operator"` produz o mesmo evento
// com a origem correta; `leaf.steered` está na allow-list de `event_type` e
// `engine`/`operator` na allow-list de `source` (`audit-model.ts`), com um
// `source` fora do vocabulário redigido em vez de vazado.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-steered.test.ts"],
} satisfies Declaracao;
