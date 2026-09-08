// Issue #165: os quatro testes de paridade (bounds, harness, process,
// socket-sentinel) perdiam o lado Python — o lado TypeScript continuava
// provando o mesmo contrato. `bounds`/`harness`/`process` saíram de
// `tests/` em #167 junto com `scripts/parity/` (sujeito apagado); só
// `socket-sentinel` sobrevive (classe B, migrado para `tests/support/
// parity/**` por #166). `tests/sem-python.test.ts` é o meta-teste que
// prende a ausência: nenhum arquivo em `tests/` volta a spawnar
// `python3`/`runPythonProcess`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/parity/socket-sentinel.test.ts", "tests/sem-python.test.ts"],
} satisfies Declaracao;
