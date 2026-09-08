// Declaração de prova da issue #155 (passo 11 do épico #13):
// scripts/mutations/all.ts e o `npm run mutations:all` que agrega as seis
// fatias de scripts/mutations/slices.json.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-all.test.ts"],
} satisfies Declaracao;
