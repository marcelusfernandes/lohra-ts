// Issue #61: bancadas dos hooks de sessão (protege-main, protege-escrita,
// stop-gate) — cada uma invoca o hook em subprocesso com payload sintético.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/protege-main.test.ts", "tests/protege-escrita.test.ts", "tests/stop-gate.test.ts"],
} satisfies Declaracao;
