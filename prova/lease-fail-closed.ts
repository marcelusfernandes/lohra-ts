// Declaração de prova da issue #356 (lease do refresh fail-closed com lock
// ilegível, dono relê sob a lease, ramos de parada testados; fatia de
// mutação `auth` de 8 para 12 mutantes).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/auth-core.test.ts"],
} satisfies Declaracao;
