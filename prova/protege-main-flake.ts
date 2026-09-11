// Declaração de prova da issue #375: `tests/protege-main.test.ts:257`
// ("gh pr merge > LOHRA_PM_ARGS_OUT sem LOHRA_BENCH não é lido: nada é
// gravado") estourou "Test timed out in 5000ms" em `checks (22)` da PR #374
// (job 103194419974, run 34577867811, HEAD 2953fe35). Esse caso é o único da
// suíte, entre os que rodam sem `LOHRA_BENCH=1`, que passa `--repo o/r`: o
// hook não lê a seam `LOHRA_PM_CHECKS_JSON` (bench desligado) e chama o `gh`
// real com um destino remoto — sob carga de CI (vários jobs concorrentes no
// mesmo runner competindo por rede/CPU), a chamada autenticada
// (`GH_TOKEN: ${{ github.token }}`, ci.yml:115) não voltou a tempo do timeout
// default do vitest. O caso irmão (linha 264, "fora de um repo") não passa
// `--repo` e nunca chega à rede: o `gh` real falha local e rápido na detecção
// de repositório (`fatal: not a git repository`, medido em 38ms) — não é
// tocado por esta issue.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/protege-main.test.ts"],
} satisfies Declaracao;
