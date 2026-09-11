// Declaração de prova da issue #375: `tests/protege-main.test.ts:~278`
// ("gh pr merge > LOHRA_PM_ARGS_OUT sem LOHRA_BENCH não é lido: nada é
// gravado") estourou "Test timed out in 5000ms" em `checks (22)` da PR #374
// (job 103194419974, run 34577867811, HEAD 2953fe35).
//
// Esse caso, e o caso irmão de "~298" ("fora de um repo"), são os únicos da
// suíte que rodam sem `LOHRA_BENCH=1` — nenhuma seam é lida, e o hook chama o
// `gh` real. Rodada 1 desta issue tinha caracterizado o primeiro como uma
// consulta de rede autenticada; isso é FALSO para o job que falhou: no job
// `checks` (`.github/workflows/ci.yml:19-58`, matriz 20/22) o passo `test`
// não define `GH_TOKEN`/`GITHUB_TOKEN` (esse token só existe no job `escopo`,
// `ci.yml:97-116`, um job diferente). Sem credencial, `gh` recusa antes de
// qualquer rede ("Please run: gh auth login", exit 4, ~29ms medido) — os
// dois casos são só exec do binário `gh`, nunca I/O de rede, tanto em CI
// quanto localmente. A duração do arquivo inteiro no attempt que falhou
// (7630ms) contra o rerun verde (1656ms) é compatível com o custo de UM
// exec de ~50MB sob contenção de I/O do runner caindo sobre o primeiro caso
// da suíte que roda `gh` de verdade — hipótese, não confirmada por medição
// isolada do custo do exec.
//
// Correção: os dois casos usam o mesmo `gh` FAKE no PATH do subprocesso
// (molde de tests/mutations-runner-guard.test.ts — `GIT_SHIM`/marcador em
// arquivo), removendo qualquer exec do `gh` real do arquivo inteiro, sem
// mudar o que cada caso afirma.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/protege-main.test.ts"],
} satisfies Declaracao;
