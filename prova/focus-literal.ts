// Issue #362: runFocusedVitest passava focus.test cru como -t do vitest, que
// o interpreta como regex — um título com "(" vira grupo (perde os
// parênteses literais) e com "." vira curinga, e o foco não bate.
// escapeFocusTest escapa os metacaracteres antes do -t, sem ancorar em
// ^…$ (os catálogos hoje passam só o título do `it`, sem o prefixo do
// `describe`; ancorar quebraria o casamento por sufixo que já dependem
// dele — confirmado manualmente contra o vitest instalado, 4.1.11).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-harness.test.ts"],
} satisfies Declaracao;
