// Issue #485 (M15, veredito da PR #483): dedup do fault de colisão, exposição
// durável de `artifact_faults`, detecção de colisão entre stretches, e
// caminho normalizado na comparação (`./x` == `x`). Os quatro cenários novos
// vivem em tests/workflow-artifacts.test.ts, describe "collision dedup,
// cross-stretch, normalized path (#485)" — o resto do arquivo continua
// cobrindo o contrato de #463 que este fix não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-artifacts.test.ts"],
} satisfies Declaracao;
